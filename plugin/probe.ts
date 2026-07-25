/**
 * Debug shim: the smallest possible ONNX workload, runnable from the devtools
 * console (or over CDP via tools/obsidian-drive.mjs).
 *
 * The point is to separate "does onnxruntime-web initialize at all inside
 * Obsidian's Electron renderer" from "does the docling pipeline work" — the
 * first is where every failure so far has been, and it needs no model download,
 * no PDF, and about a second to answer.
 *
 * Exposed as `window.__pdf2md` while the plugin is loaded.
 */
import * as ort from "onnxruntime-web";
import { configureOrt } from "./ort-env.js";

/** C = A + B over a 1x4 float tensor. 94 bytes, opset 13. */
const TINY_ADD_ONNX =
  "CAk6VAoOCgFBCgFCEgFDIgNBZGQSA2FkZFoTCgFBEg4KDAgBEggKAggBCgIIBFoTCgFCEg4KDAgB" +
  "EggKAggBCgIIBGITCgFDEg4KDAgBEggKAggBCgIIBEIECgAQDQ==";

function modelBytes(): Uint8Array {
  const bin = atob(TINY_ADD_ONNX);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** What the renderer looks like to the libraries that probe for Node. */
export function envReport() {
  const p: any = typeof process !== "undefined" ? process : null;
  return {
    obsidian: (window as any).app?.appId ? "loaded" : "?",
    location: location.origin,
    processType: p?.type ?? null,
    processVersionsNode: p?.versions?.node ?? null,
    processReleaseName: p?.release?.name ?? null,
    processVersionsNodeWritable: (() => {
      if (!p?.versions) return null;
      const d = Object.getOwnPropertyDescriptor(p.versions, "node");
      return d ? !!(d.writable ?? d.set) : null;
    })(),
    webgpu: typeof navigator !== "undefined" && "gpu" in navigator,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    crossOriginIsolated: (globalThis as any).crossOriginIsolated ?? null,
    wasmSimd: WebAssembly.validate(
      // (module (func (result v128) i32.const 0 i8x16.splat))
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    ),
    ortVersion: (ort as any).env?.versions?.common ?? null,
  };
}

/**
 * Configure ORT, then build and run the tiny model on `ep`.
 *
 * `strategy: "baseline"` deliberately reproduces the pre-fix setup (the jsdelivr
 * prefix transformers.js installs) so the failure can be demonstrated on demand.
 * ORT initializes its wasm module once per page, so only the first smoke test
 * after a reload actually exercises a strategy.
 */
export async function ortSmoke(
  { ep = "webgpu", strategy = "patched-glue" as "patched-glue" | "baseline" } = {},
) {
  const t0 = performance.now();
  const config =
    strategy === "baseline"
      ? (() => {
          (ort as any).env.wasm.wasmPaths =
            "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/dist/";
          (ort as any).env.wasm.numThreads = 1;
          return { wasmPaths: (ort as any).env.wasm.wasmPaths, baseline: true };
        })()
      : configureOrt((ort as any).env);

  try {
    const session = await ort.InferenceSession.create(modelBytes(), {
      executionProviders: [ep as any],
    });
    const tSession = performance.now();
    const out = await session.run({
      A: new ort.Tensor("float32", Float32Array.from([1, 2, 3, 4]), [1, 4]),
      B: new ort.Tensor("float32", Float32Array.from([10, 20, 30, 40]), [1, 4]),
    });
    const values = Array.from(out.C.data as Float32Array);
    const correct = JSON.stringify(values) === JSON.stringify([11, 22, 33, 44]);
    await session.release();
    return {
      ok: correct,
      ep,
      strategy,
      values,
      config,
      sessionMs: Math.round(tSession - t0),
      totalMs: Math.round(performance.now() - t0),
    };
  } catch (e: any) {
    return {
      ok: false,
      ep,
      strategy,
      config,
      error: String(e?.message ?? e),
      totalMs: Math.round(performance.now() - t0),
    };
  }
}

/** Install the shim. Returns the object for convenience. */
export function installProbe(extra: Record<string, unknown> = {}) {
  const api = { envReport, ortSmoke, ...extra };
  (window as any).__pdf2md = api;
  return api;
}
