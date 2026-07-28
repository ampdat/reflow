/**
 * Reflow — PDF → Markdown Obsidian plugin (desktop).
 *
 * Right-click a PDF in the vault (or run the command) → the engine-js core runs
 * granite-docling on WebGPU in the renderer → a Markdown package
 * (`<pdf-stem>/<pdf-stem>.md` + `images/`) lands in the vault. No server, no API
 * keys, nothing uploads.
 *
 * The whole conversion pipeline is the shared, fixture-validated core
 * (../engine-js/src/browser/engine.ts); this file is just the Obsidian shell:
 * menu/command wiring, vault I/O, and injecting transformers.js + pdf.js.
 *
 * By default the engine runs in a worker (plugin/worker.ts) so inference cannot
 * block the UI and so ORT's memory goes away with the thread; the in-renderer
 * path below is kept as the fallback and as the A/B control.
 */

import {
  App,
  FileSystemAdapter,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  normalizePath,
} from "obsidian";
import * as transformers from "@huggingface/transformers";
import * as pdfjs from "pdfjs-dist";

import type { AssembledDocument } from "../engine-js/src/core/types.js";
import { convertPdfBrowser } from "../engine-js/src/browser/engine.js";
import { buildEpub, type FormulaSidecar } from "../engine-js/src/epub.js";
import {
  deviceCandidates,
  isSlowDevice,
  probeDevices,
  slowDeviceReason,
  type DeviceNavigator,
  type DevicePreference,
  type DeviceProbe,
} from "../engine-js/src/browser/device.js";
import { pdfWorkerUrl } from "./assets.js";
import { configureOrt, tuneOrtThreads } from "./ort-env.js";
import { benchPage, benchPages, installProbe, setOrtWasmPaths } from "./probe.js";
import { convertPdfInWorker, workerBlobUrl, type WorkerConvertOptions } from "./worker-host.js";

// The esbuild banner renamed process.release.name so transformers.js (loaded
// above) would select its onnxruntime-web + WebGPU backend instead of the
// cpu-only node backend in Obsidian's Node-integrated renderer. IS_NODE_ENV is
// captured once at that point, so restore the real value now for everything else.
// (`window`, not `globalThis`: same object in the renderer, and the linter's
// popout-window rule reads any `globalThis` as a document access.)
try {
  const w = window as unknown as { __reflow_origRelease?: string };
  if (w.__reflow_origRelease && (process as any).release) {
    try {
      (process as any).release.name = w.__reflow_origRelease;
    } catch {
      /* release.name may be locked; harmless — IS_NODE_ENV is already captured */
    }
    delete w.__reflow_origRelease;
  }
} catch {
  /* ignore */
}

// pdf.js needs a worker; it is bundled and served from a blob (see assets.ts).
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl();
// Fetch model weights from the HF hub (cached in the renderer after first run).
(transformers as any).env.allowLocalModels = false;
// Configure onnxruntime-web for Obsidian's renderer. On onnxruntime-web ≥ ~1.24
// this is just thread/proxy settings; on older builds it also swaps in a patched
// emscripten glue, without which ORT can't start here at all. See plugin/ort-env.ts.
const ortConfig = configureOrt((transformers as any).env.backends.onnx);
// Let the standalone-ORT smoke test reuse these resolved sidecar URLs.
setOrtWasmPaths((transformers as any).env.backends.onnx.wasm.wasmPaths);

interface Settings {
  /** Vault folder for output; empty = alongside the source PDF. */
  outputFolder: string;
  /** 0 = all pages. */
  maxPages: number;
  /**
   * Wall-clock budget per page before generation is cut short. Dense pages emit
   * a lot of DocTags, and WebGPU throughput varies a lot by GPU, so this needs
   * to be tunable rather than a fixed engine constant.
   */
  perPageTimeoutSec: number;
  /**
   * Run the engine in a worker (default) instead of on the renderer's main
   * thread. Exposed as a setting because it is also the control arm: the
   * responsiveness and memory claims for the worker are only meaningful next to
   * a measurement of the same build without it.
   */
  useWorker: boolean;
  /**
   * Which compute backend to prefer. `auto` probes the machine and takes the
   * best available; the others force a choice, and still fall back rather than
   * fail outright. WebNN is opt-in only — see `deviceCandidates()`.
   */
  device: DevicePreference;
  /**
   * Also write an `.epub` next to the Markdown on every conversion.
   *
   * Off by default: most readers read in Obsidian, where the Markdown already
   * is the artifact, and an EPUB nobody opens is just a file in the vault.
   * Export is fast and lossless from the package, so it can be asked for at any
   * time from the note's context menu instead.
   */
  exportEpub: boolean;
}

/**
 * Amazon's Send to Kindle app. Resolved by bundle id, never by path: the app
 * lives inside a *folder* named "Send to Kindle", and a Safari web app of the
 * same name can sit beside it in /Applications.
 */
const SEND_TO_KINDLE_BUNDLE_ID = "com.amazon.SendToKindle";

const DEFAULT_SETTINGS: Settings = {
  outputFolder: "",
  maxPages: 0,
  perPageTimeoutSec: 300,
  useWorker: true,
  device: "auto",
  exportEpub: false,
};

/**
 * Live state of one conversion, owned by the conversion rather than by any view.
 *
 * The dialog is closeable (Obsidian can even close it on its own — one did, 32 s
 * into a test run) while the work carries on for minutes, so the progress can't
 * live in the modal: closing and reopening would lose the elapsed clock, the
 * per-page average and the estimate. Views read this; nothing writes back.
 */
class ConversionState {
  readonly started = Date.now();
  text = "Loading model …";
  pageCount = 0;
  page = 0;
  /** ms per completed page, for the estimate. */
  pageMs: number[] = [];
  /** Tokens emitted for the page in flight — the only true liveness signal. */
  tokens = 0;
  done = false;
  /**
   * Set once the model has loaded, if it landed somewhere slow.
   *
   * This is the difference between a conversion that looks broken and one that
   * is merely honest: on the CPU fallback a page takes minutes rather than
   * seconds, and someone watching a bar that has not moved in four minutes has
   * no way to tell those apart. Null on a normal GPU run — no warning, no noise.
   */
  slowNotice: string | null = null;
  /** Backend the model loaded on, once known — used to explain a failure. */
  device: string | null = null;
  private modelFraction = 0;
  /** Wall-clock start of the page in flight; null between pages. */
  private pageStartedAt: number | null = null;

  /**
   * What a page is assumed to cost before any page has finished. Measured pages
   * run ~30-100 s on this stack; the guess only shapes the bar during page 1 and
   * is replaced by the running average immediately after.
   */
  private static readonly FIRST_PAGE_GUESS_MS = 60_000;
  /** Highest fraction shown so far — the bar must never retreat. */
  private highWater = 0;

  constructor(readonly fileName: string, readonly cancel: () => void) {}

  setModelProgress(percent: number | null): void {
    this.text = percent == null ? "Loading model …" : `Downloading model … ${Math.round(percent)}%`;
    this.modelFraction = percent == null ? 0 : (percent / 100) * 0.05; // model load ≈ a sliver
  }

  setPage(phase: "render" | "generate", page: number, pageCount: number): void {
    if (phase === "render") {
      this.tokens = 0;
      this.pageStartedAt = Date.now();
    }
    this.text = `${phase === "render" ? "Rendering" : "Reading"} page ${page} of ${pageCount}`;
    this.page = page;
    this.pageCount = pageCount;
  }

  pageDone(page: number, pageCount: number, ms: number): void {
    this.pageMs.push(ms);
    this.pageCount = pageCount;
    this.pageStartedAt = null;
  }

  private avgPageMs(): number {
    if (!this.pageMs.length) return ConversionState.FIRST_PAGE_GUESS_MS;
    return this.pageMs.reduce((a, b) => a + b, 0) / this.pageMs.length;
  }

  /**
   * Progress in [0,1], recomputed on every render rather than stored.
   *
   * A page takes ~30-100 s, so a bar that only moves at page boundaries sits
   * still for a minute at a time — on a 2-page document it would step exactly
   * twice. Within a page we interpolate on elapsed time against the running
   * per-page average: the token counter can't do this job because it stays at 0
   * through the ~15 s prefill.
   *
   * The estimate is often wrong (a measured page 1 ran 103 s against a 45 s
   * guess), so the within-page curve must degrade gracefully rather than clip: a
   * hard cap froze the bar for 51 s — the very symptom this exists to fix. It
   * runs linearly to 80% of the page's share by the expected time, then
   * asymptotically, so an overrunning page keeps creeping and never stalls or
   * crosses into the next page's share.
   */
  fraction(): number {
    if (!this.pageCount) return this.advance(this.modelFraction);
    const done = this.pageMs.length;
    const intra =
      this.pageStartedAt == null
        ? 0
        : ConversionState.creep((Date.now() - this.pageStartedAt) / this.avgPageMs());
    return this.advance(Math.min(1, (done + intra) / this.pageCount));
  }

  /** Fraction of one page's share earned after `ratio` of its expected time. */
  private static creep(ratio: number): number {
    return ratio <= 1 ? 0.8 * ratio : 1 - 0.2 * Math.exp(-(ratio - 1));
  }

  /** Monotonic gate: phases hand over at different scales, and a bar that slips
   * backwards reads as a bug even when the underlying numbers are right. */
  private advance(v: number): number {
    this.highWater = Math.max(this.highWater, v);
    return this.highWater;
  }

  /** Compact line for the status bar shown while the dialog is closed. */
  statusBar(): string {
    const where = this.pageCount ? `page ${this.page}/${this.pageCount}` : "loading model";
    return `${this.slowNotice ? "⚠" : "⏳"} ${this.fileName} — ${where}`;
  }

  detail(): string {
    const elapsed = Math.round((Date.now() - this.started) / 1000);
    const parts = [`${fmtDuration(elapsed)} elapsed`];
    if (this.tokens) parts.unshift(`${this.tokens} tokens`);
    if (this.pageMs.length && this.pageCount) {
      const avg = this.pageMs.reduce((a, b) => a + b, 0) / this.pageMs.length / 1000;
      const left = Math.round(avg * (this.pageCount - this.pageMs.length));
      parts.push(`~${fmtDuration(left)} left`, `${avg.toFixed(0)}s/page`);
    }
    return parts.join(" · ");
  }
}

/**
 * Progress dialog — a view over `ConversionState`.
 *
 * A Notice is the wrong instrument here: conversion runs for minutes at roughly
 * half a minute per page, so the user needs to see *which* page is running,
 * whether it is still moving, and have a way out.
 *
 * Only the Cancel button cancels. Dismissing the dialog any other way detaches
 * it and lets the conversion carry on, because silently throwing away fifteen
 * minutes of GPU work on a stray close is far worse than a dialog that outlives
 * its window. An Obsidian modal also blocks the workspace, so closing it is the
 * only way to read your notes while a conversion runs — that has to be free.
 */
class ConversionModal extends Modal {
  private statusEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private warningEl!: HTMLElement;
  private barEl!: HTMLProgressElement;
  private timer: number | null = null;
  private detaches = true;

  constructor(app: App, private state: ConversionState, private onDetach: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Converting ${this.state.fileName}`);
    // Created up front and hidden, not created on demand: the notice arrives
    // mid-render from a worker message, and inserting a node then would push the
    // bar down under the user's cursor.
    this.warningEl = contentEl.createEl("p", { cls: "reflow-progress-warning" });
    this.warningEl.hide();

    this.statusEl = contentEl.createEl("p", { text: this.state.text });
    this.barEl = contentEl.createEl("progress", { cls: "reflow-progress-bar" });
    this.barEl.max = 1;
    this.barEl.value = this.state.fraction();
    this.detailEl = contentEl.createEl("p", { text: "", cls: "reflow-progress-detail" });

    contentEl.createEl("p", {
      text: "Close this dialog to keep reading while the conversion continues.",
      cls: "reflow-progress-hint",
    });

    const row = contentEl.createDiv({ cls: "reflow-progress-buttons" });
    row.createEl("button", { text: "Cancel", cls: "mod-warning" }).addEventListener("click", () => {
      this.detaches = false; // an explicit cancel, not a detach
      this.state.cancel();
      this.close();
    });

    // Progress arrives only at page boundaries, and a page takes ~30-60 s. Without
    // a clock of its own the dialog sits on one line long enough to look hung —
    // which is exactly the complaint this replaces.
    this.timer = window.setInterval(() => this.render(), 1000);
    this.render();
  }

  /** The work is over — close without treating it as a detach. */
  finish(): void {
    this.detaches = false;
    this.close();
  }

  private render(): void {
    if (!this.statusEl) return;
    this.statusEl.setText(this.state.text);
    this.barEl.value = this.state.fraction();
    this.detailEl.setText(this.state.detail());
    if (this.state.slowNotice) {
      this.warningEl.setText(this.state.slowNotice);
      this.warningEl.show();
    } else {
      this.warningEl.hide();
    }
  }

  onClose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.contentEl.empty();
    if (this.detaches && !this.state.done) this.onDetach();
  }
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
}

export default class ReflowPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  /**
   * Reopens the progress dialog of the conversion in flight, if any. Set while a
   * conversion runs so the command palette can get back to a dismissed dialog
   * even when the status bar is hidden.
   */
  showProgress: (() => void) | null = null;
  /** Blob URL for the bundled worker — created once, reused by every conversion. */
  private workerUrl: string | null = null;
  /** How the last conversion actually ran, for the probe and the log. */
  lastRunMode: "worker" | "renderer" | null = null;
  /** Environment the conversion worker reported on boot; read by the probe. */
  lastWorkerEnv: Record<string, unknown> | null = null;
  /** Compute-backend probe, run once per session (see `probeOnce`). */
  private deviceProbe: Promise<DeviceProbe> | null = null;
  /** Its resolved value, for the synchronous message path. */
  private lastProbe: DeviceProbe | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerCommands();
    if (__REFLOW_DEV__) this.installDevProbe();
  }

  /**
   * Debug shim (see plugin/probe.ts) — `window.__reflow` in the console, or
   * driven headlessly by tools/obsidian-drive.mjs.
   *
   * Development builds only. It is a global, it exposes the raw engine, and it
   * pulls in a second standalone onnxruntime-web for the ORT smoke test; a
   * release build resolves the whole module to a stub (see esbuild.config.mjs).
   */
  private installDevProbe(): void {
    const w = window as unknown as { __reflow_spoofResult?: string };

    installProbe({
      // The injected platform libs, so an ad-hoc probe can exercise pdf.js or
      // transformers.js directly (bisecting a stall to one of them) without a
      // plugin rebuild — same rationale as exposing `ort`.
      pdfjs,
      transformers,
      /**
       * Whether the esbuild banner's `process.release.name` rename took, read
       * back off the global it wrote. This used to be logged at load; it is
       * pulled rather than pushed now, which costs nothing (the plugin is
       * loaded long before anyone asks) and keeps a diagnostic that only
       * developers want out of every user's console.
       */
      backendSpoof: () => w.__reflow_spoofResult ?? null,
      readBinary: async (path: string) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) throw new Error(`not a file in the vault: ${path}`);
        return new Uint8Array(await this.app.vault.readBinary(f));
      },
      convertPath: (path: string) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) throw new Error(`not a file in the vault: ${path}`);
        return this.convert(f);
      },
      settings: () => this.settings,
      /** Flip the worker on/off from a probe without a settings-tab round trip. */
      setUseWorker: async (on: boolean) => {
        this.settings.useWorker = on;
        await this.saveSettings();
        return this.settings.useWorker;
      },
      lastRunMode: () => this.lastRunMode,
      /**
       * What the conversion worker reported about its environment on boot —
       * WebGPU, OffscreenCanvas, whether the backend spoof took there too.
       *
       * Also formerly a `console.log`. Holding it is strictly more useful than
       * printing it: `tools/obsidian-drive.mjs` can assert on the values
       * instead of a human reading them out of a console.
       */
      lastWorkerEnv: () => this.lastWorkerEnv,
      ortConfig,
      benchPage: async (path: string, opts?: Record<string, unknown>) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) throw new Error(`not a file in the vault: ${path}`);
        const data = new Uint8Array(await this.app.vault.readBinary(f));
        return benchPage({ transformers, pdfjs, data }, opts as any);
      },
      benchPages: async (path: string, opts?: Record<string, unknown>) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) throw new Error(`not a file in the vault: ${path}`);
        const data = new Uint8Array(await this.app.vault.readBinary(f));
        return benchPages({ transformers, pdfjs, data }, opts as any);
      },
    });
  }

  private registerCommands(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "pdf") {
          menu.addItem((item) =>
            item
              .setTitle("Convert to Markdown")
              .setIcon("file-text")
              .onClick(() => this.convert(file)),
          );
        }
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) =>
            item
              .setTitle("Export to EPUB")
              .setIcon("book")
              .onClick(() => {
                void this.exportEpubSafely(file);
              }),
          );
          // `open -b` is macOS-only, and so is the app. Hiding the item beats
          // offering one that cannot work.
          if (Platform.isMacOS) {
            menu.addItem((item) =>
              item
                .setTitle("Send to Kindle")
                .setIcon("send")
                .onClick(() => {
                  void this.sendToKindleSafely(file);
                }),
            );
          }
        }
      }),
    );

    this.addCommand({
      id: "convert-active-pdf",
      name: "Convert active PDF to Markdown",
      checkCallback: (checking: boolean) => {
        const f = this.app.workspace.getActiveFile();
        if (!(f instanceof TFile) || f.extension !== "pdf") return false;
        if (!checking) void this.convert(f);
        return true;
      },
    });

    this.addCommand({
      id: "export-active-note-to-epub",
      name: "Export active note to EPUB",
      checkCallback: (checking: boolean) => {
        const f = this.app.workspace.getActiveFile();
        if (!(f instanceof TFile) || f.extension !== "md") return false;
        if (!checking) void this.exportEpubSafely(f);
        return true;
      },
    });

    this.addCommand({
      id: "send-active-note-to-kindle",
      name: "Send active note to Kindle",
      checkCallback: (checking: boolean) => {
        if (!Platform.isMacOS) return false;
        const f = this.app.workspace.getActiveFile();
        if (!(f instanceof TFile) || f.extension !== "md") return false;
        if (!checking) void this.sendToKindleSafely(f);
        return true;
      },
    });

    this.addCommand({
      id: "show-conversion-progress",
      name: "Show conversion progress",
      checkCallback: (checking: boolean) => {
        if (!this.showProgress) return false;
        if (!checking) this.showProgress();
        return true;
      },
    });

    this.addSettingTab(new ReflowSettingTab(this));
  }

  /**
   * Convert `file` and write the package into the vault. Returns a small summary
   * (rather than nothing) so the debug shim can report the outcome to a driver.
   */
  async convert(file: TFile): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const state = new ConversionState(file.name, () => controller.abort());

    // The dialog can be closed and reopened at will. While it is closed, progress
    // lives in the status bar — not a Notice: Obsidian's Notices dismiss
    // themselves on click, which ate the "click to reopen" affordance and left no
    // way back to the dialog. A status bar item persists, stays out of the way,
    // and is meant to be clicked. Both are views over `state`, so nothing is lost.
    let modal: ConversionModal | null = null;
    let status: HTMLElement | null = null;
    const detach = (): void => {
      modal = null;
      if (!status) {
        status = this.addStatusBarItem();
        status.addClass("mod-clickable");
        status.setAttribute("aria-label", "Show conversion progress");
        status.addEventListener("click", () => attach());
      }
      status.setText(state.statusBar());
    };
    const attach = (): void => {
      if (state.done) return;
      status?.remove();
      status = null;
      modal = new ConversionModal(this.app, state, detach);
      modal.open();
    };
    /** Tear down whichever view is showing; the conversion is over. */
    const closeViews = (): void => {
      state.done = true;
      this.showProgress = null;
      modal?.finish();
      status?.remove();
      status = null;
    };

    this.showProgress = attach;
    attach();
    const started = performance.now();
    try {
      const data = new Uint8Array(await this.app.vault.readBinary(file));
      const doc = await this.runEngine(data, file, controller.signal, {
        onProgress: (p) => {
          if (p.phase === "page-done") state.pageDone(p.page, p.pageCount, p.ms);
          else state.setPage(p.phase, p.page, p.pageCount);
          status?.setText(state.statusBar());
        },
        // Per-token, so the dialog can prove it is alive mid-page rather than
        // sitting on one line for the ~30-60 s a page takes.
        onStep: (tokens) => {
          state.tokens = tokens;
        },
        onDevice: (info) => {
          state.device = info.device;
          if (!isSlowDevice(info.device)) return;
          state.slowNotice = this.slowDeviceMessage(info.fellBack);
          status?.setText(state.statusBar());
          new Notice(state.slowNotice, 10000);
        },
        onModelProgress: (p) => {
          if (p?.status === "progress" && p.file?.includes("decoder")) {
            state.setModelProgress(p.progress || 0);
          } else if (p?.status === "ready") {
            state.setModelProgress(null);
          }
        },
      });

      // Named from the PDF, not the extracted title: it is the identifier the
      // reader filed the paper under, it is stable across runs, and it stops
      // every converted note in the vault from being called "document".
      const parent = file.parent?.path ?? "";
      const base = this.settings.outputFolder.trim() || parent;
      const folder = normalizePath(`${base}/${file.basename}`);
      const mdPath = `${folder}/${file.basename}.md`;
      await this.ensureFolder(folder);
      await this.ensureFolder(`${folder}/images`);

      let images = 0;
      for (const fig of doc.figures) {
        if (!fig.png) continue;
        const ab = fig.png.buffer.slice(
          fig.png.byteOffset,
          fig.png.byteOffset + fig.png.byteLength,
        );
        await this.writeBinary(`${folder}/images/${fig.id}.png`, ab as ArrayBuffer);
        images++;
      }

      // Formula crops: a sidecar for exports that cannot render LaTeX. The note
      // itself is untouched and still carries `$$...$$`, which is what Obsidian
      // renders — nothing here changes how the vault reads.
      const formulas: Array<{ id: string; tex: string; page: number; suspect?: boolean }> = [];
      for (const f of doc.formulas) {
        if (!f.png) continue;
        const ab = f.png.buffer.slice(f.png.byteOffset, f.png.byteOffset + f.png.byteLength);
        await this.writeBinary(`${folder}/images/${f.id}.png`, ab as ArrayBuffer);
        formulas.push({ id: f.id, tex: f.tex, page: f.page, ...(f.suspect ? { suspect: true } : {}) });
      }
      await this.writeText(mdPath, doc.markdown);

      // The plugin used to write only the markdown and the figures, which left
      // the artifact contract asymmetric (the CLI and the Python oracle both
      // write meta.json) and left the plugin's warnings living nowhere but a
      // 6-second Notice and the console. The reader-facing half of that is the
      // banner in the note; this is the durable, machine-readable half.
      const meta = {
        source: file.path,
        title: doc.title,
        out_dir: folder,
        md_path: mdPath,
        engine: "onnx-portable",
        engine_version: this.manifest.version,
        model: doc.model,
        options: { formulas: true, ocr: false },
        pages: doc.pageCount,
        images,
        ...(formulas.length ? { formulas } : {}),
        markdown_chars: doc.markdown.length,
        timings_ms: { load: 0, inference: doc.timings.inference, assemble: doc.timings.assemble },
        wall_ms: Math.round(performance.now() - started),
        execution_providers: doc.executionProviders,
        warnings: doc.warnings,
        // Plugin-only, and worth keeping: whether the run was in a worker, and
        // the per-page cost series that made the WebGPU stall diagnosable.
        run_mode: this.lastRunMode,
        per_page: doc.timings.perPage,
      };
      await this.writeText(`${folder}/meta.json`, JSON.stringify(meta, null, 2));

      closeViews();
      // Point at the note, not the console: the warnings are now banner-ed at
      // the top of the document itself, which is where someone about to read it
      // will actually look.
      const warn = doc.warnings.length
        ? ` — ${doc.warnings.length} warning(s), listed at the top of the note`
        : "";
      if (doc.warnings.length) console.warn("[reflow]", doc.warnings);
      new Notice(`Converted → ${mdPath}${warn}`, 6000);

      const md = this.app.vault.getAbstractFileByPath(mdPath);

      // Opt-in second artifact. Done after meta.json is written, because the
      // exporter reads the formula crops back out of it, and never allowed to
      // fail the conversion — the Markdown is the contract, the EPUB is a
      // convenience.
      if (this.settings.exportEpub && md instanceof TFile) await this.exportEpubSafely(md);

      if (md instanceof TFile) await this.app.workspace.getLeaf(true).openFile(md);

      return {
        ok: true,
        folder,
        mdPath,
        title: doc.title,
        markdownChars: doc.markdown.length,
        figures: doc.figures.length,
        warnings: doc.warnings,
        mode: this.lastRunMode,
        elapsedSec: Math.round((performance.now() - started) / 1000),
        perPage: doc.timings.perPage,
      };
    } catch (e: any) {
      closeViews();
      const cancelled = e?.name === "AbortError";
      if (cancelled) {
        new Notice(`Conversion of ${file.name} cancelled`, 4000);
      } else {
        console.error("[reflow]", e);
        new Notice(this.explainFailure(e, state.device), 12000);
      }
      return {
        ok: false,
        cancelled,
        mode: this.lastRunMode,
        error: String(e?.message ?? e),
        stack: String(e?.stack ?? "").split("\n").slice(0, 6).join("\n"),
        elapsedSec: Math.round((performance.now() - started) / 1000),
      };
    }
  }

  /**
   * Run the conversion, in a worker if we can and in the renderer if we can't.
   *
   * The two paths take the same options and produce the same
   * `AssembledDocument` — the worker one just runs the identical engine in
   * another thread. Falling back is worth the branch: a missing or unloadable
   * `worker.js` (an old install that only copied main.js, say) should cost
   * responsiveness, not the feature. It says so out loud rather than quietly
   * running somewhere the user didn't expect.
   */
  private async runEngine(
    data: Uint8Array,
    file: TFile,
    signal: AbortSignal,
    hooks: Pick<WorkerConvertOptions, "onProgress" | "onStep" | "onModelProgress" | "onDevice">,
  ): Promise<AssembledDocument> {
    // Probe before anything expensive happens. An adapter request costs
    // milliseconds and no download, and knowing the answer here is what lets a
    // machine without a GPU be told so — instead of meeting a raw "Unsupported
    // device: webgpu" from inside transformers.js part-way into a conversion.
    const probe = await this.probeOnce();
    const devices = deviceCandidates(this.settings.device, probe);
    const shared = {
      maxPages: this.settings.maxPages || undefined,
      sourceLabel: file.path,
      titleFallback: file.basename,
      perPageTimeoutMs: Math.max(1, this.settings.perPageTimeoutSec) * 1000,
      devices,
      shaderF16: probe.shaderF16,
    };

    if (this.settings.useWorker) {
      let url: string | null = null;
      try {
        url = this.resolveWorkerUrl();
      } catch (e: any) {
        // Only worker *setup* falls back. Once conversion has started, a failure
        // is a real failure and must surface as one.
        console.warn(
          `[reflow] no conversion worker (${e?.message ?? e}) — ` +
            `converting on the main thread; Obsidian may feel sluggish.`,
        );
        new Notice("Converting on the main thread — worker unavailable, see console.", 6000);
      }
      if (url) {
        this.lastRunMode = "worker";
        return convertPdfInWorker(url, data, {
          ...shared,
          signal,
          ...hooks,
          onReady: (env) => {
            this.lastWorkerEnv = env;
          },
        });
      }
    }

    this.lastRunMode = "renderer";
    tuneOrtThreads((transformers as any).env.backends.onnx, devices[0]);
    return convertPdfBrowser(
      { transformers, pdfjs, data },
      {
        maxPages: shared.maxPages,
        sourceLabel: shared.sourceLabel,
        titleFallback: shared.titleFallback,
        signal,
        onProgress: hooks.onProgress,
        vlm: {
          device: devices,
          shaderF16: probe.shaderF16,
          onDevice: (info) => hooks.onDevice?.(info),
          perPageTimeoutMs: shared.perPageTimeoutMs,
          onStep: (tokens) => hooks.onStep?.(tokens),
          progressCallback: (p: any) => hooks.onModelProgress?.(p),
        },
      },
    );
  }

  /**
   * Probe the machine's compute backends once per session.
   *
   * The answer cannot change while Obsidian is running — a GPU is not hot-
   * plugged into an Electron renderer — and a failed probe is cached as a
   * probe-said-no rather than retried, so a conversion never waits on it twice.
   */
  private probeOnce(): Promise<DeviceProbe> {
    // The cast is the price of not depending on @webgpu/types: this tsconfig's
    // DOM lib predates both `navigator.gpu` and `navigator.ml`, and `device.ts`
    // declares exactly the slice it reads.
    const nav =
      typeof navigator !== "undefined" ? (navigator as unknown as DeviceNavigator) : undefined;
    this.deviceProbe ??= probeDevices(nav).then(
      (p) => {
        this.lastProbe = p;
        return p;
      },
    );
    return this.deviceProbe;
  }

  /**
   * What to tell someone whose conversion just landed on the CPU.
   *
   * The cost estimate is deliberately a range rather than "very slow". Measured
   * on the machine this was built on, a dense two-column page took 59 s on the
   * CPU against 34 s on WebGPU — 1.7×, not the order of magnitude the fallback
   * sounds like, because WebGPU and CPU are already close here (perf doc §4b).
   * A cheaper laptop CPU will be far worse, so the wording has to cover both
   * without inventing a number for hardware nobody has measured.
   */
  private slowDeviceMessage(fellBack: boolean): string {
    const platform = Platform.isWin ? "win" : Platform.isLinux ? "linux" : "mac";
    const why = this.settings.device === "wasm"
      ? "CPU is selected in settings."
      : fellBack
        ? `The GPU backend failed to start. ${slowDeviceReason(this.deviceProbeSync(), platform)}`
        : slowDeviceReason(this.deviceProbeSync(), platform);
    return (
      `Running on CPU — ${why} Expect around a minute per page on a fast machine ` +
      `and several on an older one, and note that dense pages can exhaust the CPU ` +
      `backend's memory and fail.`
    );
  }

  /**
   * Turn a runtime failure into something the user can act on.
   *
   * The one that needs it is the CPU backend's `std::bad_alloc`, which is a hard
   * ceiling rather than a bug and hits *some documents and not others*. Measured
   * here, both in the worker and in the renderer, on fresh windows: `bert.pdf`
   * page 1 converts on the CPU in 60 s, `attention.pdf` page 1 dies in 5 s — and
   * the page rasters are the same size (1191×1684 vs 1224×1584). The difference
   * is upstream of the model: the Idefics3 processor splits a page into 512-px
   * tiles by aspect ratio, giving bert 13 tiles / 878 prompt tokens and
   * attention 17 / 1142. Seventeen tiles of fp32 vision activations plus ~1 GB
   * of fp32 weights do not fit in WebAssembly's 4 GB address space; thirteen do.
   *
   * So the message says what the limit is and does not offer a fix that does not
   * exist — the honest options are a GPU or (not yet built) a lower render scale
   * on the CPU path, which would cut tiles at some cost in fidelity.
   */
  private explainFailure(e: any, device: string | null): string {
    const message = String(e?.message ?? e);
    const outOfMemory = /bad_alloc|out of memory|ERROR_CODE: 6\b/i.test(message);
    if (outOfMemory && device && isSlowDevice(device)) {
      return (
        "The CPU backend ran out of memory on this page. WebAssembly is capped at " +
        "4 GB, and pages that split into many tiles exceed it — this document needs " +
        "a GPU. Other documents may still convert on the CPU."
      );
    }
    if (outOfMemory) {
      return `Conversion ran out of memory (${message}). Try a shorter document, or restart Obsidian to free memory.`;
    }
    return `Conversion failed: ${message}`;
  }

  /**
   * The probe result, for message-building only.
   *
   * By the time a device message arrives the probe has long since resolved, but
   * the call site is synchronous; this keeps the awkwardness in one place rather
   * than making the notice path async.
   */
  private deviceProbeSync(): DeviceProbe {
    return (
      this.lastProbe ?? {
        webgpu: { available: false, reason: "No compatible GPU was found." },
        webnn: { available: false },
        shaderF16: false,
      }
    );
  }

  /** Blob URL for the bundled worker, created once per session. */
  private resolveWorkerUrl(): string {
    if (!this.workerUrl) this.workerUrl = workerBlobUrl();
    return this.workerUrl;
  }

  onunload(): void {
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
  }

  /**
   * Hand a note's EPUB to Amazon's Send to Kindle app, exporting it first if
   * there isn't a current one.
   *
   * Deliberately stops at Amazon's confirmation window. There is no CLI and no
   * scripting dictionary to drive it further, but that is not why: this is the
   * only thing the plugin does that sends the reader's document off the machine,
   * and the whole pitch is that nothing does. Their click is the consent, and it
   * belongs in Amazon's own UI where the target account is visible.
   */
  async sendToKindle(file: TFile): Promise<Record<string, unknown>> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Send to Kindle needs a local vault folder.");
    }

    const epubPath = `${file.parent?.path ?? ""}/${file.basename}.epub`;
    const existing = this.app.vault.getAbstractFileByPath(epubPath);
    // Re-export when there is nothing there, and when the note has moved on
    // since the last one: silently sending a stale book is a worse failure than
    // spending the ~40 ms, and it is invisible until someone reads it.
    const stale = existing instanceof TFile && existing.stat.mtime < file.stat.mtime;
    const exported = !(existing instanceof TFile) || stale;
    if (exported) await this.exportEpub(file);

    if (!(await adapter.exists(epubPath))) {
      throw new Error(`no EPUB was produced at ${epubPath}`);
    }
    await this.openInSendToKindle(adapter.getFullPath(epubPath));

    new Notice(
      `${exported ? "Exported and opened" : "Opened"} in Send to Kindle — ` +
        "it uploads to Amazon when you confirm there.",
      8000,
    );
    return { ok: true, epubPath, exported, stale };
  }

  /**
   * `open -b <bundle id>` rather than a hard-coded path: the app installs into a
   * *folder* called "Send to Kindle", and there is a same-named Safari web app
   * one level up that is only a bookmark. Launch Services knows which is which.
   */
  private async openInSendToKindle(absolutePath: string): Promise<void> {
    // Loaded here rather than at the top of the file, and behind the desktop
    // guard, because a static `node:` import is not loadable on mobile and the
    // community-directory review rejects one.
    //
    // `window.require` specifically, *not* `await import()`: a dynamic import of
    // a `node:` specifier is handled by Chromium's module loader, which tries to
    // fetch it as a URL and fails with "Failed to fetch dynamically imported
    // module: node:child_process". Verified in Obsidian's renderer; Electron's
    // require is the only route that works.
    if (!Platform.isDesktop) throw new Error("Send to Kindle is desktop-only.");
    const { execFile } = (
      window as unknown as { require: (id: string) => typeof import("node:child_process") }
    ).require("node:child_process");

    return new Promise((resolve, reject) => {
      execFile("open", ["-b", SEND_TO_KINDLE_BUNDLE_ID, absolutePath], (err) => {
        if (!err) return resolve();
        // `open` fails this way when Launch Services has no such bundle id,
        // which is the "not installed" case and the only one worth explaining.
        reject(
          new Error(
            "Amazon's Send to Kindle app was not found. Install it from " +
              "amazon.com/sendtokindle and try again.",
          ),
        );
      });
    });
  }

  /**
   * `exportEpub` with the failure reported to the reader rather than the console.
   * Menu items and commands are fire-and-forget, so an unhandled rejection here
   * would be silent — the one failure mode a user cannot diagnose.
   */
  private async exportEpubSafely(file: TFile): Promise<void> {
    try {
      await this.exportEpub(file);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[reflow] EPUB export failed", err);
      new Notice(`EPUB export failed: ${message}`, 8000);
    }
  }

  /** As above, for the Kindle hand-off. */
  private async sendToKindleSafely(file: TFile): Promise<void> {
    try {
      await this.sendToKindle(file);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[reflow] Send to Kindle failed", err);
      new Notice(`Send to Kindle failed: ${message}`, 10000);
    }
  }

  /**
   * Write `<note>.epub` beside a converted note.
   *
   * Works on any Markdown note, not just a freshly converted one: everything it
   * needs is in the package next to the note. When `meta.json` carries formula
   * crops the equations come out as the author's own typesetting; without them
   * (a hand-written note, or a package converted before crops existed) they come
   * out as LaTeX source and the reader is told so, rather than silently losing
   * the maths.
   */
  async exportEpub(file: TFile): Promise<Record<string, unknown>> {
    const folder = file.parent?.path ?? "";
    const epubPath = `${folder}/${file.basename}.epub`;

    let formulas: FormulaSidecar[] | undefined;
    const metaFile = this.app.vault.getAbstractFileByPath(`${folder}/meta.json`);
    if (metaFile instanceof TFile) {
      try {
        const meta = JSON.parse(await this.app.vault.cachedRead(metaFile)) as {
          formulas?: FormulaSidecar[];
        };
        formulas = meta.formulas;
      } catch {
        /* an unreadable sidecar is a missing sidecar, not a failure */
      }
    }

    const result = await buildEpub({
      markdown: await this.app.vault.cachedRead(file),
      titleFallback: file.basename,
      formulas,
      readAsset: async (rel) => {
        const asset = this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${rel}`));
        if (!(asset instanceof TFile)) return null;
        return new Uint8Array(await this.app.vault.readBinary(asset));
      },
    });

    const bytes = result.bytes;
    await this.writeBinary(
      epubPath,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );

    // The one thing worth interrupting for: equations that came out as source.
    // It is fixable (re-convert the PDF), so say so rather than leaving the
    // reader to discover it on a device.
    const note = result.formulasAsText
      ? ` — ${result.formulasAsText} equation(s) exported as LaTeX source; re-convert the PDF for equation images`
      : "";
    new Notice(`Exported → ${epubPath}${note}`, result.formulasAsText ? 10000 : 5000);
    for (const w of result.warnings) console.warn("[reflow]", w);

    return {
      ok: true,
      epubPath,
      chapters: result.chapters,
      images: result.images,
      formulasAsCrop: result.formulasAsCrop,
      formulasAsText: result.formulasAsText,
      warnings: result.warnings,
    };
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(path)) {
      try {
        await this.app.vault.createFolder(path);
      } catch {
        /* concurrent create / already exists */
      }
    }
  }

  /**
   * `Vault.process` rather than `Vault.modify`: converting is a background job,
   * and the note it overwrites may be open in a pane. `process` reads and
   * replaces atomically, which is what the guidelines ask for when the edit
   * isn't coming from the editor.
   */
  private async writeText(path: string, data: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.process(existing, () => data);
    else await this.app.vault.create(path, data);
  }

  private async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data);
    else await this.app.vault.createBinary(path, data);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class ReflowSettingTab extends PluginSettingTab {
  constructor(private plugin: ReflowPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Vault folder for converted packages. Empty = alongside the PDF.")
      .addText((t) =>
        t
          .setPlaceholder("Papers")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (v) => {
            this.plugin.settings.outputFolder = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Max pages")
      .setDesc("0 = all pages. Set a small number for quick tests.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxPages)).onChange(async (v) => {
          this.plugin.settings.maxPages = parseInt(v, 10) || 0;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Per-page time limit (seconds)")
      .setDesc(
        "Generation for a page is cut off after this long, and the page is flagged " +
          "incomplete. Raise it for dense pages or a slower GPU.",
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.perPageTimeoutSec)).onChange(async (v) => {
          this.plugin.settings.perPageTimeoutSec = parseInt(v, 10) || DEFAULT_SETTINGS.perPageTimeoutSec;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Compute backend")
      .setDesc(
        "Automatic picks the fastest available and falls back to the CPU if there is no " +
          "usable GPU. The CPU backend is slower and cannot handle every page — dense " +
          "pages can exhaust its memory. WebNN needs Obsidian launched with " +
          "--enable-features=WebMachineLearningNeuralNetwork and is experimental.",
      )
      .addDropdown((d) =>
        d
          .addOptions({
            auto: "Automatic (recommended)",
            webgpu: "GPU (WebGPU)",
            webnn: "Neural accelerator (WebNN, experimental)",
            wasm: "CPU (very slow)",
          })
          .setValue(this.plugin.settings.device)
          .onChange(async (v) => {
            this.plugin.settings.device = v as DevicePreference;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Convert in a background thread")
      .setDesc(
        "Keeps Obsidian responsive during conversion and frees the model's memory " +
          "when it finishes. Turn off only to diagnose a conversion problem.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useWorker).onChange(async (v) => {
          this.plugin.settings.useWorker = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Also export EPUB")
      .setDesc(
        "Write an .epub next to the Markdown on every conversion, for reading on a " +
          "Kindle or other e-reader. You can also export any note at any time from " +
          "its right-click menu.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.exportEpub).onChange(async (v) => {
          this.plugin.settings.exportEpub = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
