/**
 * Make onnxruntime-web load inside Obsidian's renderer.
 *
 * The failure this fixes
 * ---------------------
 * transformers.js sets `env.backends.onnx.wasm.wasmPaths` to a jsdelivr prefix
 * at import time. ORT's `importWasmModule()` only uses the emscripten glue that
 * is *already inlined* in the bundle when no path override is present, so that
 * prefix makes it dynamically import `ort-wasm-simd-threaded.jsep.mjs` from the
 * CDN instead. That standalone file ends with:
 *
 *     var isNode = typeof globalThis.process?.versions?.node == 'string';
 *     if (isNode) isPthread = (await import('worker_threads')).workerData === 'em-pthread';
 *
 * — a *top-level* await, with no `process.type !== "renderer"` guard (unlike the
 * check inside the module body, which does have one). Obsidian's renderer has
 * Node integration, so `process.versions.node` is a string, so the glue tries to
 * ESM-import `worker_threads`, which is not a resolvable specifier in a renderer.
 * The module never evaluates and ORT reports "no available backend found.
 * ERR: [webgpu] Failed to resolve module specifier 'worker_threads'".
 *
 * It cannot be worked around at runtime — Electron makes `process.versions.node`
 * non-writable — and it cannot be patched at bundle time in the normal way,
 * because the offending file is fetched from a CDN at runtime and never passes
 * through esbuild.
 *
 * The fix
 * -------
 * Point `wasmPaths.mjs` at a *blob URL* holding a build-time-patched copy of the
 * glue (see `virtual:ort-glue` in esbuild.config.mjs, which strips that epilogue
 * and fails the build if it ever stops matching), and give `wasmPaths.wasm`
 * explicitly since a blob URL has no useful base for resolving siblings. ORT
 * imports our copy, takes the web path, and initializes normally.
 */

// Patched emscripten glue source, inlined by the esbuild plugin at build time.
// @ts-ignore — virtual module, see plugin/virtual.d.ts
import PATCHED_ORT_GLUE from "virtual:ort-glue";

/**
 * Whether the installed glue already carries the upstream fix (onnxruntime-web
 * ~1.24-1.26 added `process?.type != "renderer"` to the epilogue). When it does,
 * the whole override below is unnecessary and we leave transformers.js's own
 * `wasmPaths` alone — fewer moving parts, and its sidecar caching keeps working.
 *
 * Decided by the build (see `analyzeOrtGlue` in esbuild.config.mjs) rather than
 * by inspecting the inlined text here, because in this case there *is* no
 * inlined text: shipping 92 KB of unused emscripten glue put `require("fs")`
 * into main.js and got the plugin flagged for filesystem access it never
 * performs.
 */
const GLUE_IS_FIXED_UPSTREAM = !__REFLOW_ORT_GLUE_PATCHED__;

let glueUrl: string | null = null;

/** Blob URL for the patched glue, created once per session. */
function patchedGlueUrl(): string {
  if (!glueUrl) {
    glueUrl = URL.createObjectURL(
      new Blob([PATCHED_ORT_GLUE], { type: "text/javascript" }),
    );
  }
  return glueUrl;
}

export interface OrtEnvReport {
  /** How the glue is being supplied: upstream-fixed, or our patched blob. */
  strategy: "upstream" | "patched-glue";
  wasmPaths: unknown;
  numThreads: number;
  glueBytes: number;
}

/**
 * Apply the working configuration to an onnxruntime-web `env` object (either
 * ORT's own, or `transformers.env.backends.onnx`, which is the same shape).
 *
 * `wasmUrl` overrides where the .wasm is fetched from; only meaningful on the
 * patched-glue path, where a blob URL has no base to resolve siblings against.
 */
export function configureOrt(ortEnv: any, opts: { wasmUrl?: string } = {}): OrtEnvReport {
  // WebGPU compute needs no wasm threads, and single-threaded keeps ORT from
  // preloading the glue as a worker script. `tuneOrtThreads` raises this when
  // the CPU fallback is the one actually running.
  ortEnv.wasm.numThreads = 1;
  ortEnv.wasm.proxy = false;

  if (!GLUE_IS_FIXED_UPSTREAM) {
    const mjs = patchedGlueUrl();
    const wasm =
      opts.wasmUrl ??
      `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortEnv.versions?.web ?? "1.22.0"}/dist/ort-wasm-simd-threaded.jsep.wasm`;
    ortEnv.wasm.wasmPaths = { mjs, wasm };
  }

  return {
    strategy: GLUE_IS_FIXED_UPSTREAM ? "upstream" : "patched-glue",
    wasmPaths: ortEnv.wasm.wasmPaths,
    numThreads: ortEnv.wasm.numThreads,
    glueBytes: (PATCHED_ORT_GLUE as string).length,
  };
}

/**
 * Pick the wasm thread count for the backend that is about to run.
 *
 * On WebGPU the wasm module is only glue — the compute is on the GPU — so one
 * thread is right and avoids ORT preloading the glue as a worker script. On the
 * CPU fallback the opposite holds: the wasm module *is* the compute, and a
 * single thread on a 258M-parameter fp32 VLM is the difference between slow and
 * unusable.
 *
 * Threads need `SharedArrayBuffer`, which browsers gate behind cross-origin
 * isolation; Obsidian's Node-integrated renderer has it regardless, but the
 * check stays because a missing SAB makes ORT fail at init rather than fall
 * back. Capped at 4: this competes with the UI thread and with whatever else the
 * machine is doing, and the returns flatten well before core count.
 *
 * Must be called *before* the first session is created — ORT reads it when the
 * wasm module initializes and ignores it afterwards.
 */
export function tuneOrtThreads(ortEnv: any, device: string): number {
  let threads = 1;
  if (device === "wasm" || device === "cpu") {
    const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 1) : 1;
    const threaded = typeof SharedArrayBuffer !== "undefined";
    threads = threaded ? Math.max(1, Math.min(4, cores - 1)) : 1;
  }
  try {
    ortEnv.wasm.numThreads = threads;
  } catch {
    /* an env that refuses the write just keeps its default */
  }
  return threads;
}
