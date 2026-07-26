/**
 * Renderer side of the conversion worker: spawn, drive one conversion, dispose.
 *
 * The worker is deliberately **single-use**. ORT does not return all of its
 * native allocations on `dispose()` — RSS climbed 2528 → 5156 → 7313 MB across
 * successive conversions in one process — so the only reliable way to give the
 * memory back is to end the context that owns it. A cold start costs a model
 * load (~1 s from cache) against a conversion measured in minutes.
 *
 * `convertPdfInWorker` mirrors `convertPdfBrowser`'s signature closely enough
 * that main.ts can fall back to the in-renderer path unchanged if a worker
 * cannot be created.
 */

import type { ConvertProgress } from "../engine-js/src/core/convert.js";
import type { AssembledDocument } from "../engine-js/src/core/types.js";
import type { ModelProgress, WorkerMessage, WorkerRequest } from "./worker-protocol.js";

export interface WorkerConvertOptions {
  maxPages?: number;
  sourceLabel: string;
  titleFallback: string;
  perPageTimeoutMs: number;
  device?: string;
  signal?: AbortSignal;
  onProgress?: (p: ConvertProgress) => void;
  onStep?: (tokens: number) => void;
  onModelProgress?: (p: ModelProgress) => void;
  /** Environment the worker reported on boot — logged once, for diagnosis. */
  onReady?: (env: Record<string, unknown>) => void;
}

/**
 * Blob URL holding the worker bundle.
 *
 * A worker script must be same-origin, and the plugin folder is not served over
 * one — Obsidian's renderer runs at `app://obsidian.md` while the code lives in
 * the vault. Reading the bundle through the vault adapter and handing it to the
 * worker as a blob sidesteps that entirely, and is how Obsidian plugins
 * conventionally ship workers.
 */
export async function workerBlobUrl(
  readPluginFile: (name: string) => Promise<string>,
): Promise<string> {
  const source = await readPluginFile("worker.js");
  if (!source.trim()) throw new Error("worker.js is empty");
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

export async function convertPdfInWorker(
  workerUrl: string,
  data: Uint8Array,
  opts: WorkerConvertOptions,
): Promise<AssembledDocument> {
  const worker = new Worker(workerUrl, { name: "pdf-to-md" });

  // A copy, because the buffer is transferred: `data` comes from
  // `vault.readBinary` and detaching it would surprise the caller.
  const buffer = data.slice().buffer as ArrayBuffer;

  const send = (msg: WorkerRequest, transfer: Transferable[] = []) =>
    worker.postMessage(msg, transfer);

  const onAbort = () => send({ type: "cancel" });
  opts.signal?.addEventListener("abort", onAbort);

  try {
    return await new Promise<AssembledDocument>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
        const msg = ev.data;
        switch (msg.type) {
          case "ready":
            opts.onReady?.(msg.env);
            send(
              {
                type: "convert",
                data: buffer,
                opts: {
                  maxPages: opts.maxPages,
                  sourceLabel: opts.sourceLabel,
                  titleFallback: opts.titleFallback,
                  perPageTimeoutMs: opts.perPageTimeoutMs,
                  device: opts.device,
                },
              },
              [buffer],
            );
            // The signal may have aborted while the worker was still booting.
            if (opts.signal?.aborted) send({ type: "cancel" });
            break;
          case "progress":
            opts.onProgress?.(msg.p);
            break;
          case "model":
            opts.onModelProgress?.(msg.p);
            break;
          case "step":
            opts.onStep?.(msg.tokens);
            break;
          case "log":
            console[msg.level](`[pdf-to-md worker] ${msg.text}`);
            break;
          case "done":
            resolve(msg.doc);
            break;
          case "error": {
            const err = new Error(msg.message);
            err.name = msg.name; // preserves AbortError, which main.ts branches on
            err.stack = msg.stack;
            reject(err);
            break;
          }
        }
      };
      // A worker that dies (OOM, a module that fails to evaluate) fires `error`
      // and then nothing. Without this the conversion promise never settles and
      // the progress dialog ticks forever — the exact failure mode this whole
      // milestone has been chasing, so it gets an explicit rejection.
      worker.onerror = (e: ErrorEvent) =>
        reject(new Error(`conversion worker failed: ${e.message || "unknown error"}`));
      worker.onmessageerror = () =>
        reject(new Error("conversion worker sent an unclonable message"));
    });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    worker.terminate();
  }
}
