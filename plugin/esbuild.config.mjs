// Bundle main.ts (+ the engine-js core, transformers.js, pdf.js) into a single
// CJS dist/main.js for Obsidian, and stage manifest.json alongside it so `dist/`
// is a drop-in plugin folder. `obsidian` and `electron` are provided by the host.
import esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

// onnxruntime-web's threaded jsep wasm glue detects Node via
// `typeof globalThis.process?.versions?.node == 'string'` (no renderer guard) and
// then does `import('worker_threads')` / `import("module")`, which can't resolve as
// ESM bare specifiers in Obsidian's renderer. Patch that vendored file at bundle
// time: force the node checks false and neutralize the node-only dynamic imports so
// emscripten uses the web path (Web Worker / no threads). Runtime spoofing can't do
// this — Electron locks process.versions.node.
const patchOrtNodeDetection = {
  name: "patch-ort-node-detection",
  setup(build) {
    build.onLoad({ filter: /ort-wasm.*\.mjs$/ }, (args) => {
      let contents = readFileSync(args.path, "utf8");
      const subs = [
        ["typeof globalThis.process?.versions?.node == 'string'", "false"],
        ['"string"==typeof process.versions.node&&"renderer"!=process.type', "false"],
        ["await import('worker_threads')", "await Promise.resolve({workerData:undefined,Worker:globalThis.Worker})"],
        ['await import("worker_threads")', 'await Promise.resolve({workerData:undefined,Worker:globalThis.Worker})'],
        ['await import("module")', 'await Promise.resolve({createRequire:function(){return function(){return {Worker:globalThis.Worker}}}})'],
        ['require("worker_threads")', "({Worker:globalThis.Worker})"],
      ];
      let hits = 0;
      for (const [from, to] of subs) {
        if (contents.includes(from)) {
          contents = contents.split(from).join(to);
          hits++;
        }
      }
      console.log(`  [patch-ort] ${args.path.split("/").pop()}: ${hits}/${subs.length} patterns patched`);
      return { contents, loader: "js" };
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
  plugins: [patchOrtNodeDetection],
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
