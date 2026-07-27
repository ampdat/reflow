/**
 * WebNN availability stub — one probe, run in several environments so the
 * answers are directly comparable.
 *
 * Written as a bare function body ending in `return`, because that is what
 * obsidian-drive.mjs's `eval`/`eval-file` expects. `webnn-check.mjs` runs the
 * same text in Node via AsyncFunction, and it can be pasted straight into a
 * Chrome devtools console (wrap in `(async () => { ... })()` there).
 *
 *   node tools/webnn-check.mjs                            # Node
 *   node tools/obsidian-drive.mjs eval-file tools/webnn-probe.js   # Obsidian
 *
 * The question this answers: is WebNN simply absent (Chromium ships it behind
 * the WebMachineLearningNeuralNetwork feature flag, and Obsidian's Electron does
 * not enable it), versus present-but-unusable for a given device type.
 */
const out = {
  env: typeof process !== "undefined" && process.versions?.electron
    ? `electron ${process.versions.electron}`
    : typeof window !== "undefined"
      ? `browser: ${navigator.userAgent.slice(0, 90)}`
      : `node ${typeof process !== "undefined" ? process.version : "?"}`,
  hasNavigator: typeof navigator !== "undefined",
  hasNavigatorML: typeof navigator !== "undefined" && "ml" in navigator,
  hasMLGraphBuilder: typeof MLGraphBuilder !== "undefined",
  contexts: {},
  ort: null,
};

// Which device types can actually produce a context? Chromium maps these to
// CoreML on macOS; "npu" may quietly fall back to GPU/CPU where there is no NPU.
if (out.hasNavigatorML) {
  for (const deviceType of ["npu", "gpu", "cpu"]) {
    try {
      const ctx = await navigator.ml.createContext({ deviceType, powerPreference: "high-performance" });
      out.contexts[deviceType] = ctx ? "ok" : "null";
    } catch (e) {
      out.contexts[deviceType] = `ERR: ${String(e?.message || e).slice(0, 120)}`;
    }
  }
}

// If an ORT build is reachable, ask it directly — this is the configuration in
// question: webnn/npu first, then webgpu, then wasm.
try {
  const ort =
    (typeof globalThis.ort !== "undefined" && globalThis.ort) ||
    (typeof window !== "undefined" && window.__reflow ? window.__reflow.ort : null);
  if (ort?.InferenceSession) {
    // 94-byte Add model: C = A + B over a 1x4 float tensor.
    const b64 =
      "CAk6VAoOCgFBCgFCEgFDIgNBZGQSA2FkZFoTCgFBEg4KDAgBEggKAggBCgIIBFoTCgFCEg4KDAgBEggKAggBCgIIBGITCgFDEg4KDAgBEggKAggBCgIIBEIECgAQDQ==";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const providers = [
      { name: "webnn", deviceType: "npu", powerPreference: "high-performance" },
      "webgpu",
      "wasm",
    ];
    try {
      const session = await ort.InferenceSession.create(bytes, { executionProviders: providers });
      const r = await session.run({
        A: new ort.Tensor("float32", Float32Array.from([1, 2, 3, 4]), [1, 4]),
        B: new ort.Tensor("float32", Float32Array.from([10, 20, 30, 40]), [1, 4]),
      });
      out.ort = { created: true, values: Array.from(r.C.data) };
      await session.release?.();
    } catch (e) {
      out.ort = { created: false, error: String(e?.message || e).slice(0, 300) };
    }
  } else {
    out.ort = "no ORT reachable in this environment";
  }
} catch (e) {
  out.ort = `probe error: ${String(e?.message || e).slice(0, 200)}`;
}

return out;
