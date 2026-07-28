/**
 * SPIKE probe — can the *plugin* render math without shipping MathJax?
 *
 * The Node prototype (engine-js/tools/md2epub.mjs) renders formulas with
 * `mathjax-full`: 41 MB installed, 662 KB gzipped if bundled, against a plugin
 * that is currently 1.34 MB gzipped. That is a lot to add to something whose
 * whole pitch is "no server, no account" — but Obsidian renders `$$...$$` in
 * every note, so it has a MathJax in there already. If we can reach it and get
 * **SVG** out of it, EPUB stage 3 costs us nothing.
 *
 * Three independent things have to be true, checked separately so a partial
 * answer is still useful:
 *
 *   1. MathJax is reachable from the renderer at all.
 *   2. It can produce SVG, not just Obsidian's on-screen output. CHTML is
 *      useless to us: it positions glyphs from web fonts that will not exist
 *      inside an EPUB, and it cannot be rasterized.
 *   3. The renderer can turn an SVG into PNG bytes — canvas will draw it and
 *      `toDataURL` will not throw on a tainted canvas.
 *
 * Note on (1): MathJax is **lazy**. `window.MathJax` is undefined on a fresh
 * launch and stays undefined until something renders math, and `loadMathJax()`
 * lives in the `obsidian` module, which is plugin-scope — `require("obsidian")`
 * throws from a bare CDP eval. So the probe opens a note that contains math and
 * waits, which works regardless of whether a plugin is installed.
 *
 *   node tools/obsidian-drive.mjs eval-file tools/mathjax-probe.js
 *
 * Result on Obsidian 1.x / Electron 39, 2026-07-27:
 *   version 3.2.2, functions [tex2chtml, tex2chtmlPromise, tex2mml,
 *   tex2mmlPromise, typeset*, ...] — no tex2svg; MathJax._.output has only
 *   {chtml, chtml_ts, common}, i.e. the SVG jax is absent, not merely unexposed.
 *   Rasterization, however, works: canvas drew an SVG and returned PNG bytes.
 */
const out = { step: "start" };
try {
  // 1 — force MathJax to load by opening a note that has math in it.
  out.step = "load";
  if (typeof window.MathJax === "undefined") {
    let withMath = null;
    for (const f of app.vault.getMarkdownFiles()) {
      if ((await app.vault.cachedRead(f)).includes("$$")) {
        withMath = f;
        break;
      }
    }
    out.mathNote = withMath ? withMath.path : null;
    if (withMath) {
      await app.workspace.getLeaf(true).openFile(withMath);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  const MJ = window.MathJax;
  out.hasMathJax = !!MJ;
  if (!MJ) {
    out.note = "no note in this vault rendered math; open one with $$...$$ and re-run";
    return out;
  }

  // 2 — what can it actually do?
  out.version = MJ.version || null;
  out.fns = Object.keys(MJ)
    .filter((k) => typeof MJ[k] === "function")
    .sort();
  out.hasTex2svg = typeof MJ.tex2svg === "function";
  out.hasTex2mml = typeof MJ.tex2mml === "function";
  // The decisive check: is the SVG output jax in the bundle at all, or just
  // not wired to a convenience function?
  out.outputSubmodules = MJ._ && MJ._.output ? Object.keys(MJ._.output).sort() : null;
  out.hasLoader = !!MJ.loader; // present, but loading a component means a CDN fetch

  const TEX = "\\frac{QK^T}{\\sqrt{d_k}}";
  let svg = null;
  if (out.hasTex2svg) {
    out.step = "tex2svg";
    const node = MJ.tex2svg(TEX, { display: true });
    svg = node.querySelector("svg") ? node.querySelector("svg").outerHTML : null;
    // `<use>` means the glyphs live in a document-level <defs>; such an SVG
    // renders blank once detached, so we would need fontCache off.
    out.svgSelfContained = svg ? !svg.includes("<use") : null;
  }
  if (out.hasTex2mml) {
    out.step = "tex2mml";
    out.mmlHead = MJ.tex2mml(TEX, { display: true }).slice(0, 80);
  }

  // 3 — will the renderer rasterize an SVG we hand it? Use MathJax's output
  // if we got any, otherwise a trivial SVG: the question is about canvas, not
  // about MathJax.
  out.step = "rasterize";
  const probeSvg =
    svg || '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text x="2" y="15">x</text></svg>';
  const img = new Image();
  const loaded = await new Promise((res) => {
    img.onload = () => res(true);
    img.onerror = () => res(false);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(probeSvg);
  });
  out.svgImgLoaded = loaded;
  if (loaded) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, img.width * 2);
    canvas.height = Math.max(1, img.height * 2);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // toDataURL throws on a tainted canvas — the failure mode being tested.
    const png = canvas.toDataURL("image/png");
    out.pngBytes = Math.round(png.length * 0.75);
    out.pngOk = png.startsWith("data:image/png") && out.pngBytes > 100;
  }

  out.step = "done";
  return out;
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
  return out;
}
