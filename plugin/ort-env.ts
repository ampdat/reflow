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

/** Version of @huggingface/transformers whose dist the .wasm is fetched from. */
const TRANSFORMERS_VERSION = "3.7.5";

const WASM_FILE = "ort-wasm-simd-threaded.jsep.wasm";

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
  wasmPaths: { mjs: string; wasm: string };
  numThreads: number;
  glueBytes: number;
  gluePatched: boolean;
}

/**
 * Apply the working configuration to an onnxruntime-web `env` object (either
 * ORT's own, or `transformers.env.backends.onnx`, which is the same shape).
 */
export function configureOrt(ortEnv: any, opts: { wasmUrl?: string } = {}): OrtEnvReport {
  const wasm = opts.wasmUrl ??
    `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/${WASM_FILE}`;
  const mjs = patchedGlueUrl();

  ortEnv.wasm.wasmPaths = { mjs, wasm };
  // WebGPU compute needs no wasm threads, and single-threaded keeps ORT from
  // preloading the glue as a worker script.
  ortEnv.wasm.numThreads = 1;
  ortEnv.wasm.proxy = false;

  return {
    wasmPaths: { mjs, wasm },
    numThreads: ortEnv.wasm.numThreads,
    glueBytes: (PATCHED_ORT_GLUE as string).length,
    // The build fails unless exactly one renderer-guarded reference remains.
    gluePatched: !(PATCHED_ORT_GLUE as string).includes("await import('worker_threads')"),
  };
}
