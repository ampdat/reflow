/**
 * Message shapes exchanged between the plugin (renderer) and the conversion
 * worker. Shared by both ends so a change to one is a type error in the other.
 *
 * Everything crossing the boundary is structured-clonable: the PDF goes in as an
 * ArrayBuffer and the figures come back as Uint8Arrays, both transferred rather
 * than copied. Callbacks (`onProgress`, `onStep`, `progress_callback`) cannot
 * cross, so each becomes a message the host re-dispatches to the real callback.
 */

import type { ConvertProgress } from "../engine-js/src/core/convert.js";
import type { AssembledDocument } from "../engine-js/src/core/types.js";

export interface WorkerConvertRequest {
  type: "convert";
  data: ArrayBuffer;
  opts: {
    maxPages?: number;
    sourceLabel: string;
    titleFallback: string;
    perPageTimeoutMs: number;
    /** transformers.js device, e.g. "webgpu". Overridable for A/B probing. */
    device?: string;
  };
}

/**
 * Cancel the conversion in flight.
 *
 * The host also terminates the worker once a conversion settles, which would
 * cancel it too — but abruptly, mid-GPU-op. Asking first lets the engine unwind
 * through its own abort path (`createGuard`), which is the tested one.
 */
export interface WorkerCancelRequest {
  type: "cancel";
}

/**
 * Diagnostic: rasterize pages and hand the pixels back, no inference.
 *
 * The worker renders without a `document` (see `browser/pdf.ts`), which is the
 * only way it can affect *output quality* rather than just where the work runs.
 * Comparing DocTags would confound that with decoding noise; comparing pixels
 * against the same pages rendered on the main thread measures it directly.
 * Never sent by `worker-host.ts` — only by `tools/raster-diff-probe.js`.
 */
export interface WorkerRasterRequest {
  type: "raster";
  pages: number[];
  data: Uint8Array;
}

export type WorkerRequest = WorkerConvertRequest | WorkerCancelRequest | WorkerRasterRequest;

/** Slimmed transformers.js progress event — the full one is not clonable. */
export interface ModelProgress {
  status: string;
  file?: string;
  progress?: number;
}

export type WorkerMessage =
  /** Worker booted and its libraries evaluated; carries what it found. */
  | { type: "ready"; env: Record<string, unknown> }
  | { type: "progress"; p: ConvertProgress }
  | { type: "model"; p: ModelProgress }
  | { type: "step"; tokens: number }
  /** Renderer-side console mirror; worker consoles land on a separate CDP target. */
  | { type: "log"; level: "log" | "warn" | "error"; text: string }
  | { type: "done"; doc: AssembledDocument }
  /** Reply to `raster` — diagnostic only, see `WorkerRasterRequest`. */
  | {
      type: "raster";
      pages: Record<number, { w: number; h: number; rgba: Uint8ClampedArray }>;
    }
  | { type: "error"; name: string; message: string; stack: string };
