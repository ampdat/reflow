/** Virtual modules provided by esbuild plugins (see esbuild.config.mjs). */
declare module "virtual:ort-glue" {
  /** Patched onnxruntime-web emscripten glue, inlined as text at build time. */
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
