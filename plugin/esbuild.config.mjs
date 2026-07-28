// Bundle main.ts (+ the engine-js core, transformers.js, pdf.js) into a single
// CJS dist/main.js for Obsidian, and stage manifest.json + styles.css alongside
// it. `obsidian` and `electron` are provided by the host.
//
// `dist/` deliberately holds *exactly* the three files Obsidian's community
// installer downloads (main.js, manifest.json, styles.css) — anything else in
// the plugin folder exists on a developer's machine and nowhere else.
//
// That constraint is why worker.ts is bundled to `build/worker.js` (scratch,
// gitignored) and then inlined into main.js as text: the conversion worker used
// to be read back from the plugin folder at runtime, which works for a folder
// copy and silently degrades to main-thread conversion for every user who
// installs from the directory. pdf.js's parsing worker is inlined the same way,
// so no executable code is fetched over the network. See plugin/assets.ts.
import esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
// Dev builds keep the debug shim (plugin/probe.ts) and its standalone
// onnxruntime-web copy; release builds resolve it to a stub instead.
const dev = watch || process.argv.includes("--dev");

// onnxruntime-web's standalone emscripten glue ends with a *top-level* await that
// has no renderer guard:
//
//   var isNode = typeof globalThis.process?.versions?.node == 'string';
//   if (isNode) isPthread = (await import('worker_threads')).workerData === 'em-pthread';
//
// In Obsidian's Node-integrated renderer that specifier can't resolve, the module
// never evaluates, and ORT reports "no available backend found". ORT normally
// avoids this file (it has the glue inlined), but transformers.js sets a jsdelivr
// `wasmPaths` prefix, which forces the CDN copy to be imported instead — so the
// file never passes through this bundle and can't be patched by an onLoad hook.
//
// Instead, inline a *patched* copy as text under `virtual:ort-glue`; ort-env.ts
// serves it from a blob URL via `wasmPaths.mjs`. See plugin/ort-env.ts.
//
// The decision is made **here, at build time**, and the text is inlined only if
// a patch is actually needed. It used to be inlined unconditionally and the
// same question asked again at runtime, which cost more than the 92 KB: the
// glue's own Node branch (`var fs = require("fs")`, `require("path")`,
// `require("os")`) sat in main.js as dead string data, and Obsidian's review
// reads the bundle, not the guard around it. The plugin was reported as
// "Direct Filesystem Access ... can read and write any file on the system" on
// the strength of text it never executes. Encoding the string to hide it would
// be obfuscation, which the developer policies forbid outright — and would be
// the wrong instinct anyway. Not shipping it is the honest fix.
const ORT_GLUE = "node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs";
const GLUE_EPILOGUE =
  "if (isNode) isPthread = (await import('worker_threads')).workerData === 'em-pthread';";

/**
 * Does the installed glue still need our patch, and if so, what does the
 * patched copy look like?
 *
 * Runs once per build rather than per bundle, so both the main and the worker
 * context agree — and so the answer can be `define`d into both.
 */
function analyzeOrtGlue() {
  const source = readFileSync(ORT_GLUE, "utf8");

  // onnxruntime-web ~1.24-1.26 added the missing guard upstream, so on a
  // current transformers there is nothing to patch. Detect that rather than
  // assuming a version: `process?.type != "renderer"` in the epilogue.
  if (/isPthread\s*=\s*\(await import\(["']worker_threads["']\)\)/.test(source)) {
    const epilogue = source.slice(source.lastIndexOf("export default"));
    if (/process\??\.type\s*!=/.test(epilogue)) {
      console.log("  [ort-glue] upstream glue guards on process.type — nothing inlined");
      return { patched: false, source: "" };
    }
  }

  if (!source.includes(GLUE_EPILOGUE)) {
    // Neither the known-broken epilogue nor the upstream fix: fail loudly
    // rather than shipping a glue we only think we understand.
    throw new Error(
      `[ort-glue] unrecognized node-detection epilogue in ${ORT_GLUE}. ` +
        `onnxruntime-web changed; re-check the patch in plugin/ort-env.ts.`,
    );
  }
  const patched = source.replace(GLUE_EPILOGUE, "// [reflow] node pthread bootstrap removed");
  // One `worker_threads` reference legitimately survives: the one inside the
  // module body, which *is* guarded by `"renderer" != process.type` and so is
  // unreachable here. Anything else means the patch missed something.
  const remaining = patched.split("worker_threads").length - 1;
  if (remaining !== 1 || !patched.includes('"renderer"!=process.type')) {
    throw new Error(
      `[ort-glue] expected exactly one renderer-guarded worker_threads reference ` +
        `after patching, found ${remaining} (guard present: ` +
        `${patched.includes('"renderer"!=process.type')})`,
    );
  }
  console.log(`  [ort-glue] patched ${(patched.length / 1024).toFixed(1)} KB of emscripten glue`);
  return { patched: true, source: patched };
}

const ortGlue = analyzeOrtGlue();

const inlinePatchedOrtGlue = {
  name: "inline-patched-ort-glue",
  setup(build) {
    build.onResolve({ filter: /^virtual:ort-glue$/ }, () => ({
      path: "virtual:ort-glue",
      namespace: "ort-glue",
    }));
    build.onLoad({ filter: /.*/, namespace: "ort-glue" }, () => ({
      contents: ortGlue.source,
      loader: "text",
    }));
  },
};

/**
 * Serve `virtual:<name>` as the text of a file on disk.
 *
 * `watchFiles` is what makes the two-bundle arrangement work under `--watch`:
 * main.js is rebuilt whenever build/worker.js is rewritten, so editing worker.ts
 * still lands in the installed plugin without a manual ordering dance.
 */
const inlineTextFiles = (mapping) => ({
  name: "inline-text-files",
  setup(build) {
    const filter = new RegExp(`^virtual:(${Object.keys(mapping).join("|")})$`);
    build.onResolve({ filter }, (args) => ({
      path: args.path.slice("virtual:".length),
      namespace: "inline-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "inline-text" }, (args) => {
      const file = mapping[args.path];
      const contents = readFileSync(file, "utf8");
      if (!contents.trim()) throw new Error(`[inline-text] ${file} is empty`);
      return { contents, loader: "text", watchFiles: [file] };
    });
  },
});

/**
 * Release builds swap plugin/probe.ts for a no-op stub.
 *
 * The shim is developer tooling — it hangs an API off `window` and pulls in a
 * second, standalone onnxruntime-web for the ORT smoke test. Neither belongs in
 * a build users install, and the automated review flags the global.
 */
const stubProbeInRelease = {
  name: "stub-probe-in-release",
  setup(build) {
    if (dev) return;
    build.onResolve({ filter: /(^|\/)probe\.js$/ }, () => ({
      path: new URL("probe-stub.ts", import.meta.url).pathname,
    }));
  },
};

const PDFJS_WORKER = "node_modules/pdfjs-dist/build/pdf.worker.min.mjs";

// Obsidian's renderer has Node integration, so transformers.js sees
// process.release.name === "node" and picks its cpu-only onnxruntime-node
// backend — no WebGPU. This banner runs before any bundled module evaluates and
// temporarily makes that check fail, so transformers captures IS_NODE_ENV=false
// and offers the onnxruntime-web + WebGPU backend. main.ts restores it right after.
// process.release is often not reassignable in Electron, so mutate `.name`
// directly, then fall back to defineProperty on the name, then on release.
const forceWebBackend = `(function(){try{var p=(typeof process!=="undefined")?process:null;if(p&&p.release&&p.release.name==="node"){globalThis.__reflow_origRelease=p.release.name;try{p.release.name="obsidian";}catch(e){}if(p.release.name==="node"){try{Object.defineProperty(p.release,"name",{value:"obsidian",configurable:true,writable:true});}catch(e){}}if(p.release.name==="node"){try{Object.defineProperty(p,"release",{value:Object.assign({},p.release,{name:"obsidian"}),configurable:true,writable:true});}catch(e){}}globalThis.__reflow_spoofResult=p.release.name;}else{globalThis.__reflow_spoofResult=p&&p.release?p.release.name:"no-process";}}catch(e){globalThis.__reflow_spoofResult="err:"+(e&&e.message);}})();`;

mkdirSync("dist", { recursive: true });
mkdirSync("build", { recursive: true });

const shared = {
  bundle: true,
  target: "es2022",
  platform: "browser",
  external: ["obsidian", "electron", "@electron/remote", "@codemirror/*", "@lezer/*"],
  // The worker needs the spoof as much as the renderer does: Obsidian launches
  // with --node-integration-in-worker, so `process.release.name === "node"` is
  // true there too and transformers.js would pick its cpu-only node backend.
  banner: { js: forceWebBackend },
  define: {
    __REFLOW_DEV__: String(dev),
    // Whether `virtual:ort-glue` carries a patched copy at all. Asked at build
    // time so ort-env.ts doesn't have to re-derive it by regexing text that,
    // on a healthy dependency tree, isn't in the bundle.
    __REFLOW_ORT_GLUE_PATCHED__: String(ortGlue.patched),
  },
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

// The worker bundle is built first and inlined into main.js as text, so it must
// not import anything from main.ts — and it carries its own copy of pdf.js's
// parsing worker, because it rasterizes pages on its own thread.
const workerCtx = await esbuild.context({
  ...shared,
  entryPoints: ["worker.ts"],
  format: "iife",
  outfile: "build/worker.js",
  plugins: [inlinePatchedOrtGlue, inlineTextFiles({ "pdf-worker": PDFJS_WORKER })],
});

const mainCtx = await esbuild.context({
  ...shared,
  entryPoints: ["main.ts"],
  format: "cjs",
  outfile: "dist/main.js",
  plugins: [
    inlinePatchedOrtGlue,
    stubProbeInRelease,
    inlineTextFiles({ "pdf-worker": PDFJS_WORKER, worker: "build/worker.js" }),
  ],
});

// manifest.json lives at the *repository* root, not next to the source: the
// community directory reads the manifest at the HEAD of the default branch, so
// that copy is the one the world sees and there must not be a second one here to
// drift from it. The build stages it into dist/ with the bundle.
const MANIFEST = "../manifest.json";

function stageAssets() {
  copyFileSync(MANIFEST, "dist/manifest.json");
  copyFileSync("styles.css", "dist/styles.css");
}

// Strictly sequential: main.js inlines the worker bundle, so it has to exist.
await workerCtx.rebuild();
await mainCtx.rebuild();
stageAssets();

if (watch) {
  await workerCtx.watch();
  await mainCtx.watch();
  console.log("watching… (dist/)");
} else {
  await Promise.all([workerCtx.dispose(), mainCtx.dispose()]);
  console.log(
    `built${dev ? " (dev: debug shim included)" : ""} → dist/{main.js,manifest.json,styles.css}`,
  );
}
