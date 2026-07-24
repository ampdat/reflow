// Bundle main.ts (+ the engine-js core, transformers.js, pdf.js) into a single
// CJS main.js for Obsidian. `obsidian` and `electron` are provided by the host.
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  outfile: "main.js",
  external: ["obsidian", "electron", "@electron/remote", "@codemirror/*", "@lezer/*"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("watching…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
