/** Virtual modules provided by esbuild plugins (see esbuild.config.mjs). */
declare module "virtual:ort-glue" {
  /**
   * Patched onnxruntime-web emscripten glue, inlined as text at build time —
   * and empty whenever `__REFLOW_ORT_GLUE_PATCHED__` is false, which is the
   * normal case on a current dependency tree.
   */
  const source: string;
  export default source;
}

declare module "virtual:worker" {
  /** The bundled conversion worker (build/worker.js), inlined as text. */
  const source: string;
  export default source;
}

declare module "virtual:pdf-worker" {
  /** pdf.js's parsing worker, inlined as text so nothing is fetched to run. */
  const source: string;
  export default source;
}

/** True in `--dev`/`--watch` builds; `define`d away in release builds. */
declare const __REFLOW_DEV__: boolean;

/** True when the build had to inline a patched copy of the ORT wasm glue. */
declare const __REFLOW_ORT_GLUE_PATCHED__: boolean;
