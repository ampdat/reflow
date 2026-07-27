/**
 * Conversion worker — the whole engine, off the renderer's main thread.
 *
 * Why this exists
 * ---------------
 * Inference is a long stretch of synchronous work: measured event-loop lag in
 * the renderer during a conversion was 877 ms in one run (prefill is one long
 * block) and 4.5 ms in another (decode is many short ones). Obsidian stayed
 * usable but could feel stuck mid-page, and no amount of progress-dialog work
 * fixes that — the dialog is on the same thread that is blocked.
 *
 * It is also the fix for the other open blocker: ORT's native allocations were
 * not fully returned between conversions (RSS 2528 → 5156 → 7313 MB over
 * successive fixtures despite `dispose()`), so a session of several PDFs grew
 * until it died. A worker is a disposal boundary the allocator cannot argue
 * with — the host terminates it after every conversion.
 *
 * A worker is not, however, a free pass on the rAF render stall: Chromium does
 * expose `requestAnimationFrame` on a worker global (measured here — present,
 * and it fires), so `browser/pdf.ts` keeps its scheduling shim on. What the
 * worker genuinely lacks is `document`, which the same adapter now handles.
 *
 * This file is bundled separately (`dist/worker.js`) and loaded from a blob URL
 * by `worker-host.ts`; it must not import anything from `main.ts`.
 */

import * as transformers from "@huggingface/transformers";
import * as pdfjs from "pdfjs-dist";

import {
  convertPdfBrowser,
  loadPdfBrowser,
  type LoadPdfBrowserOptions,
} from "../engine-js/src/browser/engine.js";
import { configureOrt, tuneOrtThreads } from "./ort-env.js";
import { CMAP_URL, STANDARD_FONT_DATA_URL, pdfWorkerUrl } from "./assets.js";
import type { WorkerMessage, WorkerRequest } from "./worker-protocol.js";

/**
 * There is no `document` here, so pdf.js rasterizes the standard fonts from
 * their own outlines and needs the font programs — without them it drops glyphs
 * and hands the VLM a page with holes in the text (measured: 25 dropped
 * characters on page 1 of `attention.pdf`, no error).
 */
const PDF_OPTIONS: LoadPdfBrowserOptions = {
  standardFontDataUrl: STANDARD_FONT_DATA_URL,
  cMapUrl: CMAP_URL,
};

/**
 * The worker global, spelled out rather than pulled in from TypeScript's
 * `WebWorker` lib: this file shares a tsconfig with the renderer code, and
 * loading both `DOM` and `WebWorker` collides on dozens of shared names.
 */
interface WorkerGlobal {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
}

declare const self: WorkerGlobal;

function post(msg: WorkerMessage, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

/**
 * Mirror the worker's console into the renderer's.
 *
 * A dedicated worker is its own CDP target, so its console never reaches the
 * page target the driver tails (`tools/obsidian-drive.mjs console`). Without
 * this, moving the engine into a worker would have silently thrown away the
 * logging that every diagnosis so far depended on.
 */
for (const level of ["log", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      post({
        type: "log",
        level,
        text: args
          .map((a) => (typeof a === "string" ? a : safeJson(a)))
          .join(" "),
      });
    } catch {
      /* an unclonable argument must not break logging */
    }
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Same wiring as the renderer path (see main.ts). The esbuild banner already
// spoofed process.release.name before these modules evaluated, so transformers
// captured IS_NODE_ENV=false and offers onnxruntime-web + WebGPU: Obsidian
// launches with --node-integration-in-worker, so `process` exists here too and
// the check fires exactly as it does on the main thread.
// pdf.js can't spawn a nested worker from here, so it `import()`s this URL as
// its "fake worker" and parses on this thread — still off the main thread.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl();
(transformers as any).env.allowLocalModels = false;
const ortConfig = configureOrt((transformers as any).env.backends.onnx);

/**
 * Cancellation flag for the conversion in flight.
 *
 * The engine takes a `{ aborted: boolean }` rather than an AbortSignal, and a
 * signal could not be cloned across the boundary anyway, so `cancel` just flips
 * this. It is read between pages and between decode steps.
 */
let signal: { aborted: boolean } | null = null;

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === "cancel") {
    if (signal) signal.aborted = true;
    return;
  }
  if (msg.type === "raster") {
    try {
      const pages = await loadPdfBrowser(pdfjs, msg.data, PDF_OPTIONS);
      const out: Record<number, { w: number; h: number; rgba: Uint8ClampedArray }> = {};
      try {
        for (const p of msg.pages) {
          const r = await pages.renderPage(p);
          out[p] = { w: r.width, h: r.height, rgba: r.rgba };
        }
      } finally {
        await pages.destroy();
      }
      post({ type: "raster", pages: out });
    } catch (e: any) {
      post({ type: "error", name: "Error", message: String(e?.message ?? e), stack: "" });
    }
    return;
  }
  if (msg.type !== "convert") return;

  signal = { aborted: false };
  // Thread count has to be set before the first session is created, and the
  // renderer already probed the machine, so the head of the candidate list is
  // what this is sized for. A fallback further down the list runs
  // single-threaded — slower still, but it is the last-resort path either way.
  const devices = msg.opts.devices?.length ? msg.opts.devices : ["webgpu", "wasm"];
  tuneOrtThreads((transformers as any).env.backends.onnx, devices[0]);
  try {
    const doc = await convertPdfBrowser(
      { transformers, pdfjs, data: new Uint8Array(msg.data) },
      {
        maxPages: msg.opts.maxPages,
        sourceLabel: msg.opts.sourceLabel,
        titleFallback: msg.opts.titleFallback,
        pdf: PDF_OPTIONS,
        signal,
        onProgress: (p) => post({ type: "progress", p }),
        vlm: {
          device: devices,
          shaderF16: msg.opts.shaderF16,
          onDevice: (info) => post({ type: "device", ...info }),
          perPageTimeoutMs: msg.opts.perPageTimeoutMs,
          onStep: (tokens) => post({ type: "step", tokens }),
          progressCallback: (p: any) =>
            post({
              type: "model",
              p: { status: p?.status, file: p?.file, progress: p?.progress },
            }),
        },
      },
    );

    // Transfer the figure bytes rather than copying them: a paper's worth of
    // page-resolution PNGs is tens of MB, and this is the one message big
    // enough for the copy to be worth avoiding.
    const transfer: Transferable[] = [];
    for (const fig of doc.figures) if (fig.png) transfer.push(fig.png.buffer as ArrayBuffer);
    post({ type: "done", doc }, transfer);
  } catch (e: any) {
    post({
      type: "error",
      name: String(e?.name ?? "Error"),
      message: String(e?.message ?? e),
      stack: String(e?.stack ?? ""),
    });
  } finally {
    signal = null;
  }
};

post({
  type: "ready",
  env: {
    webgpu: typeof navigator !== "undefined" && "gpu" in navigator,
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    hasDocument: typeof (globalThis as any).document !== "undefined",
    hasRaf: typeof (globalThis as any).requestAnimationFrame === "function",
    processReleaseName: (globalThis as any).process?.release?.name ?? null,
    spoof: (globalThis as any).__reflow_spoofResult ?? null,
    ortStrategy: ortConfig.strategy,
  },
});
