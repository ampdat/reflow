// Bundle main.ts (+ the engine-js core, transformers.js, pdf.js) into a single
// CJS dist/main.js for Obsidian, and stage manifest.json alongside it so `dist/`
// is a drop-in plugin folder. `obsidian` and `electron` are provided by the host.
import esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

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
const ORT_GLUE = "node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs";
const GLUE_EPILOGUE =
  "if (isNode) isPthread = (await import('worker_threads')).workerData === 'em-pthread';";

const inlinePatchedOrtGlue = {
  name: "inline-patched-ort-glue",
  setup(build) {
    build.onResolve({ filter: /^virtual:ort-glue$/ }, () => ({
      path: "virtual:ort-glue",
      namespace: "ort-glue",
    }));
    build.onLoad({ filter: /.*/, namespace: "ort-glue" }, () => {
      const source = readFileSync(ORT_GLUE, "utf8");
      if (!source.includes(GLUE_EPILOGUE)) {
        // Fail loudly rather than shipping a glue we only think we patched:
        // if ORT changes this line, the plugin would silently break again.
        throw new Error(
          `[ort-glue] node-detection epilogue not found in ${ORT_GLUE}. ` +
            `onnxruntime-web changed; re-check the patch in plugin/ort-env.ts.`,
        );
      }
      const patched = source.replace(GLUE_EPILOGUE, "// [pdf-to-md] node pthread bootstrap removed");
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
      return { contents: patched, loader: "text" };
    });
  },
};

// Obsidian's renderer has Node integration, so transformers.js sees
// process.release.name === "node" and picks its cpu-only onnxruntime-node
// backend — no WebGPU. This banner runs before any bundled module evaluates and
// temporarily makes that check fail, so transformers captures IS_NODE_ENV=false
// and offers the onnxruntime-web + WebGPU backend. main.ts restores it right after.
// process.release is often not reassignable in Electron, so mutate `.name`
// directly, then fall back to defineProperty on the name, then on release.
const forceWebBackend = `(function(){try{var p=(typeof process!=="undefined")?process:null;if(p&&p.release&&p.release.name==="node"){globalThis.__pdf2md_origRelease=p.release.name;try{p.release.name="obsidian";}catch(e){}if(p.release.name==="node"){try{Object.defineProperty(p.release,"name",{value:"obsidian",configurable:true,writable:true});}catch(e){}}if(p.release.name==="node"){try{Object.defineProperty(p,"release",{value:Object.assign({},p.release,{name:"obsidian"}),configurable:true,writable:true});}catch(e){}}globalThis.__pdf2md_spoofResult=p.release.name;}else{globalThis.__pdf2md_spoofResult=p&&p.release?p.release.name:"no-process";}}catch(e){globalThis.__pdf2md_spoofResult="err:"+(e&&e.message);}})();`;

mkdirSync("dist", { recursive: true });

const ctx = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  outfile: "dist/main.js",
  external: ["obsidian", "electron", "@electron/remote", "@codemirror/*", "@lezer/*"],
  banner: { js: forceWebBackend },
  plugins: [inlinePatchedOrtGlue],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
});

function stageManifest() {
  copyFileSync("manifest.json", "dist/manifest.json");
}

if (watch) {
  await ctx.watch();
  stageManifest();
  console.log("watching… (dist/)");
} else {
  await ctx.rebuild();
  stageManifest();
  await ctx.dispose();
  console.log("built → dist/{main.js,manifest.json}");
}
