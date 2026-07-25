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
  Menu,
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
import { benchPage, installProbe, setOrtWasmPaths } from "./probe.js";

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

export default class PdfToMdPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;

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

    this.addSettingTab(new PdfToMdSettingTab(this));
  }

  /**
   * Convert `file` and write the package into the vault. Returns a small summary
   * (rather than nothing) so the debug shim can report the outcome to a driver.
   */
  async convert(file: TFile): Promise<Record<string, unknown>> {
    const notice = new Notice(`Converting ${file.name} …`, 0);
    const started = performance.now();
    try {
      const data = new Uint8Array(await this.app.vault.readBinary(file));

      const doc = await convertPdfBrowser(
        { transformers, pdfjs, data },
        {
          maxPages: this.settings.maxPages || undefined,
          sourceLabel: file.path,
          titleFallback: file.basename,
          vlm: {
            perPageTimeoutMs: Math.max(1, this.settings.perPageTimeoutSec) * 1000,
            progressCallback: (p: any) => {
              if (p?.status === "progress" && p.file?.includes("decoder")) {
                notice.setMessage(`Downloading model … ${Math.round(p.progress || 0)}%`);
              } else if (p?.status === "ready") {
                notice.setMessage("Running conversion on WebGPU …");
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

      notice.hide();
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
      };
    } catch (e: any) {
      notice.hide();
      console.error("[pdf-to-md]", e);
      new Notice(`Conversion failed: ${e?.message ?? e}`, 8000);
      return {
        ok: false,
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
