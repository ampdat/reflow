// Bundle main.ts (+ the engine-js core, transformers.js, pdf.js) into a single
// CJS dist/main.js for Obsidian, and stage manifest.json alongside it so `dist/`
// is a drop-in plugin folder. `obsidian` and `electron` are provided by the host.
import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

// Obsidian's renderer has Node integration, so transformers.js sees
// process.release.name === "node" and picks its cpu-only onnxruntime-node
// backend — no WebGPU. This banner runs before any bundled module evaluates and
// temporarily makes that check fail, so transformers captures IS_NODE_ENV=false
// and offers the onnxruntime-web + WebGPU backend. main.ts restores it right after.
const forceWebBackend = `(function(){try{if(typeof process!=="undefined"&&process.release&&process.release.name==="node"){globalThis.__pdf2md_origRelease=process.release;process.release=Object.assign({},process.release,{name:"obsidian"});}}catch(e){}})();`;

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
