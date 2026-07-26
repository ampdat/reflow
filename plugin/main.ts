/**
 * PDF → Markdown Obsidian plugin (desktop).
 *
 * Right-click a PDF in the vault (or run the command) → the engine-js core runs
 * granite-docling on WebGPU in the renderer → a Markdown package (document.md +
 * images/) lands in the vault. No server, no API keys, nothing uploads.
 *
 * The whole conversion pipeline is the shared, fixture-validated core
 * (../engine-js/src/browser/engine.ts); this file is just the Obsidian shell:
 * menu/command wiring, vault I/O, and injecting transformers.js + pdf.js.
 */

import {
  App,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  normalizePath,
} from "obsidian";
import * as transformers from "@huggingface/transformers";
import * as pdfjs from "pdfjs-dist";

import { convertPdfBrowser, sanitizeDirname } from "../engine-js/src/browser/engine.js";
import { configureOrt } from "./ort-env.js";
import { benchPage, benchPages, installProbe, setOrtWasmPaths } from "./probe.js";

// The esbuild banner renamed process.release.name so transformers.js (loaded
// above) would select its onnxruntime-web + WebGPU backend instead of the
// cpu-only node backend in Obsidian's Node-integrated renderer. IS_NODE_ENV is
// captured once at that point, so restore the real value now for everything else.
try {
  const g = globalThis as any;
  if (g.__pdf2md_origRelease && (process as any).release) {
    try {
      (process as any).release.name = g.__pdf2md_origRelease;
    } catch {
      /* release.name may be locked; harmless — IS_NODE_ENV is already captured */
    }
    delete g.__pdf2md_origRelease;
  }
} catch {
  /* ignore */
}

// pdf.js needs a worker; use the CDN module worker (first run only, then cached).
pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
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
}

const DEFAULT_SETTINGS: Settings = { outputFolder: "", maxPages: 0, perPageTimeoutSec: 300 };

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
    return `⏳ ${this.fileName} — ${where}`;
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
  private barEl!: HTMLProgressElement;
  private timer: number | null = null;
  private detaches = true;

  constructor(app: App, private state: ConversionState, private onDetach: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Converting ${this.state.fileName}`);
    this.statusEl = contentEl.createEl("p", { text: this.state.text });
    this.barEl = contentEl.createEl("progress");
    this.barEl.style.width = "100%";
    this.barEl.max = 1;
    this.barEl.value = this.state.fraction();
    this.detailEl = contentEl.createEl("p", { text: "" });
    this.detailEl.style.opacity = "0.7";
    this.detailEl.style.fontSize = "0.85em";

    const hint = contentEl.createEl("p", {
      text: "Close this dialog to keep reading while the conversion continues.",
    });
    hint.style.opacity = "0.55";
    hint.style.fontSize = "0.8em";

    const row = contentEl.createDiv();
    row.style.display = "flex";
    row.style.justifyContent = "flex-end";
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

export default class PdfToMdPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  /**
   * Reopens the progress dialog of the conversion in flight, if any. Set while a
   * conversion runs so the command palette can get back to a dismissed dialog
   * even when the status bar is hidden.
   */
  showProgress: (() => void) | null = null;

  async onload(): Promise<void> {
    const g = globalThis as any;
    console.log(
      `[pdf-to-md] backend spoof: ${g.__pdf2md_spoofResult} | ` +
        `navigator.gpu: ${typeof navigator !== "undefined" && "gpu" in navigator} | ` +
        `ort glue: ${ortConfig.strategy} (${ortConfig.glueBytes} B)`,
    );

    // Debug shim (see plugin/probe.ts) — `window.__pdf2md` in the console, or
    // driven headlessly by tools/obsidian-drive.mjs.
    installProbe({
      // The injected platform libs, so an ad-hoc probe can exercise pdf.js or
      // transformers.js directly (bisecting a stall to one of them) without a
      // plugin rebuild — same rationale as exposing `ort`.
      pdfjs,
      transformers,
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

    await this.loadSettings();

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
      }),
    );

    this.addCommand({
      id: "convert-active-pdf",
      name: "Convert active PDF to Markdown",
      checkCallback: (checking: boolean) => {
        const f = this.app.workspace.getActiveFile();
        const ok = !!f && f.extension === "pdf";
        if (ok && !checking) this.convert(f as TFile);
        return ok;
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

    this.addSettingTab(new PdfToMdSettingTab(this));
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

      const doc = await convertPdfBrowser(
        { transformers, pdfjs, data },
        {
          maxPages: this.settings.maxPages || undefined,
          sourceLabel: file.path,
          titleFallback: file.basename,
          signal: controller.signal,
          onProgress: (p) => {
            if (p.phase === "page-done") state.pageDone(p.page, p.pageCount, p.ms);
            else state.setPage(p.phase, p.page, p.pageCount);
            status?.setText(state.statusBar());
          },
          vlm: {
            perPageTimeoutMs: Math.max(1, this.settings.perPageTimeoutSec) * 1000,
            // Per-token, so the dialog can prove it is alive mid-page rather
            // than sitting on one line for the ~30-60 s a page takes.
            onStep: (tokens) => {
              state.tokens = tokens;
            },
            progressCallback: (p: any) => {
              if (p?.status === "progress" && p.file?.includes("decoder")) {
                state.setModelProgress(p.progress || 0);
              } else if (p?.status === "ready") {
                state.setModelProgress(null);
              }
            },
          },
        },
      );

      const parent = file.parent?.path ?? "";
      const base = this.settings.outputFolder.trim() || parent;
      const folder = normalizePath(`${base}/${sanitizeDirname(doc.title) || file.basename}`);
      await this.ensureFolder(folder);
      await this.ensureFolder(`${folder}/images`);

      for (const fig of doc.figures) {
        if (!fig.png) continue;
        const ab = fig.png.buffer.slice(
          fig.png.byteOffset,
          fig.png.byteOffset + fig.png.byteLength,
        );
        await this.writeBinary(`${folder}/images/${fig.id}.png`, ab as ArrayBuffer);
      }
      await this.writeText(`${folder}/document.md`, doc.markdown);

      closeViews();
      const warn = doc.warnings.length
        ? ` — ${doc.warnings.length} warning(s), see console`
        : "";
      if (doc.warnings.length) console.warn("[pdf-to-md]", doc.warnings);
      new Notice(`Converted → ${folder}/document.md${warn}`, 6000);

      const md = this.app.vault.getAbstractFileByPath(`${folder}/document.md`);
      if (md instanceof TFile) await this.app.workspace.getLeaf(true).openFile(md);

      return {
        ok: true,
        folder,
        title: doc.title,
        markdownChars: doc.markdown.length,
        figures: doc.figures.length,
        warnings: doc.warnings,
        elapsedSec: Math.round((performance.now() - started) / 1000),
        perPage: doc.timings.perPage,
      };
    } catch (e: any) {
      closeViews();
      const cancelled = e?.name === "AbortError";
      if (cancelled) {
        new Notice(`Conversion of ${file.name} cancelled`, 4000);
      } else {
        console.error("[pdf-to-md]", e);
        new Notice(`Conversion failed: ${e?.message ?? e}`, 8000);
      }
      return {
        ok: false,
        cancelled,
        error: String(e?.message ?? e),
        stack: String(e?.stack ?? "").split("\n").slice(0, 6).join("\n"),
        elapsedSec: Math.round((performance.now() - started) / 1000),
      };
    }
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

  private async writeText(path: string, data: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, data);
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

class PdfToMdSettingTab extends PluginSettingTab {
  constructor(private plugin: PdfToMdPlugin) {
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
          .setPlaceholder("e.g. Papers")
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
  }
}
