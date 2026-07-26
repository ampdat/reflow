/**
 * Pinpoint the page-1 stall: which single pdf.js call parks forever?
 *
 * `loadPdfBrowser` + `renderPage` are several worker round-trips behind one
 * promise each, so a hang inside them is invisible from outside. This walks the
 * same sequence one await at a time, logs before and after each, and races each
 * against a timeout — so a stall names itself instead of just never returning.
 *
 *   node tools/obsidian-drive.mjs eval-file tools/render-stall-probe.js
 */
const { pdfjs, readBinary } = window.__pdf2md;

const steps = [];
const say = (m) => console.log(`[stall-probe] ${m}`);

/** Race `thunk` against `ms`; record the outcome either way, never throw. */
async function step(label, ms, thunk) {
  say(`→ ${label}`);
  const t0 = Date.now();
  let out;
  try {
    out = await Promise.race([
      Promise.resolve(thunk()).then((value) => ({ ok: true, value })),
      new Promise((r) => setTimeout(() => r({ ok: false, timedOut: true }), ms)),
    ]);
  } catch (e) {
    out = { ok: false, error: String(e?.message ?? e) };
  }
  const row = { label, ms: Date.now() - t0, ...out };
  steps.push(row);
  say(`← ${label}: ${row.ok ? `ok (${row.ms}ms)` : row.timedOut ? `TIMED OUT after ${ms}ms` : `ERROR ${row.error}`}`);
  return out.ok ? out.value : null;
}

steps.push({
  label: "worker-config",
  workerSrc: pdfjs.GlobalWorkerOptions.workerSrc,
  version: pdfjs.version ?? null,
});

const data = await step("readBinary", 30_000, () => readBinary("attention.pdf"));

// pdf.js transfers the buffer to its worker, detaching it — each getDocument
// needs its own copy.
const doc = await step("getDocument", 60_000, () =>
  pdfjs.getDocument({ data: data.slice(), isEvalSupported: false }).promise,
);
if (doc) {
  steps.push({ label: "pageCount", value: doc.numPages });
  // Is there a real Web Worker behind this, or did pdf.js fall back to parsing
  // on the main thread? The two fail very differently.
  try {
    const w = doc._transport?._params?.worker ?? doc._transport?.messageHandler?.comObj;
    steps.push({ label: "worker", fakeWorker: !!pdfjs.PDFWorker?._isWorkerDisabled, comObj: String(w?.constructor?.name ?? w) });
  } catch (e) {
    steps.push({ label: "worker", error: String(e?.message ?? e) });
  }

  const page = await step("getPage(1)", 60_000, () => doc.getPage(1));
  if (page) {
    const viewport = page.getViewport({ scale: 2.0 });
    const w = Math.ceil(viewport.width);
    const h = Math.ceil(viewport.height);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, w, h);
    steps.push({ label: "canvas", size: `${w}x${h}` });

    await step("page.render", 120_000, () => page.render({ canvasContext: ctx, viewport }).promise);
    await step("getImageData", 30_000, () => ctx.getImageData(0, 0, w, h).data.length);
    await step("getTextContent", 60_000, () => page.getTextContent().then((c) => c.items.length));
  }
}

return { steps };
