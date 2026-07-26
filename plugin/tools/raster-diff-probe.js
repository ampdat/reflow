/**
 * Does the worker rasterize pages the same way the renderer does?
 *
 * Run with `node tools/obsidian-drive.mjs run-file tools/raster-diff-probe.js`.
 *
 * This is the one place the worker could change *output quality* rather than
 * just where the work happens. Without a `document`, pdf.js can't build scratch
 * canvases or register FontFaces, so the worker path supplies an OffscreenCanvas
 * factory, a no-op filter factory and `disableFontFace` (see `browser/pdf.ts`).
 * Font rasterization in particular then goes through glyph outlines instead of
 * the platform font stack — a real difference in the image the VLM reads.
 *
 * Comparing DocTags output would confound this with decoding noise, so compare
 * the pixels: same pages, both paths, count how many differ and by how much.
 */

const FILE = "attention.pdf";
const PAGES = [1, 4, 8]; // prose, equations, the BLEU results table

const api = window.__pdf2md;
if (!api) throw new Error("plugin not loaded");

// A fresh copy per render: pdf.js transfers the input buffer to its worker, so
// the second consumer of one Uint8Array gets a detached, empty array — and
// pdf.js answers that by hanging rather than throwing.
const source = await api.readBinary(FILE);
const bytes = () => source.slice();

/** Render pages on the main thread, where pdf.js has a document. */
async function renderHere() {
  const pages = await api.loadPdfBrowser(api.pdfjs, bytes());
  const out = {};
  try {
    for (const p of PAGES) {
      const r = await pages.renderPage(p);
      out[p] = { w: r.width, h: r.height, rgba: r.rgba.slice() };
    }
  } finally {
    await pages.destroy();
  }
  return out;
}

/** Render the same pages inside the conversion worker. */
async function renderThere() {
  const dir = app.plugins.plugins["pdf-to-md"].manifest.dir;
  const src = await app.vault.adapter.read(dir + "/worker.js");
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const w = new Worker(url, { name: "raster-diff" });
  try {
    return await new Promise((resolve, reject) => {
      w.onerror = (e) => reject(new Error(e.message || "worker error"));
      w.onmessage = (e) => {
        if (e.data.type === "ready") w.postMessage({ type: "raster", pages: PAGES, data: bytes() });
        else if (e.data.type === "raster") resolve(e.data.pages);
        else if (e.data.type === "error") reject(new Error(e.data.message));
        else if (e.data.type === "log") console.log("[worker]", e.data.text);
      };
      setTimeout(() => reject(new Error("worker raster timed out")), 120000);
    });
  } finally {
    w.terminate();
    URL.revokeObjectURL(url);
  }
}

const [here, there] = [await renderHere(), await renderThere()];

const rows = PAGES.map((p) => {
  const a = here[p];
  const b = there[p];
  if (!a || !b) return { page: p, error: "missing render" };
  if (a.w !== b.w || a.h !== b.h) {
    return { page: p, error: `size ${a.w}x${a.h} vs ${b.w}x${b.h}` };
  }
  let differing = 0;
  let sumAbs = 0;
  let maxAbs = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    // Luma is what a page raster is really about; comparing all four channels
    // would flag alpha noise that no reader (or VLM) can see.
    const la = 0.299 * a.rgba[i] + 0.587 * a.rgba[i + 1] + 0.114 * a.rgba[i + 2];
    const lb = 0.299 * b.rgba[i] + 0.587 * b.rgba[i + 1] + 0.114 * b.rgba[i + 2];
    const d = Math.abs(la - lb);
    if (d > 8) differing++;
    sumAbs += d;
    if (d > maxAbs) maxAbs = d;
  }
  const px = a.rgba.length / 4;
  return {
    page: p,
    size: `${a.w}x${a.h}`,
    pixels: px,
    differingPct: +((100 * differing) / px).toFixed(3),
    meanAbsLuma: +(sumAbs / px).toFixed(3),
    maxAbsLuma: Math.round(maxAbs),
  };
});

return { file: FILE, rows };
