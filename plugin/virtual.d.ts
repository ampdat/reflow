/** Virtual modules provided by esbuild plugins (see esbuild.config.mjs). */
declare module "virtual:ort-glue" {
  /** Patched onnxruntime-web emscripten glue, inlined as text at build time. */
  const source: string;
  export default source;
}
