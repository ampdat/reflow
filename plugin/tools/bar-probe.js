/**
 * Does the progress bar move *within* a page, or only at page boundaries?
 *
 * Samples the <progress> element's own value (not the text) every 3 s across
 * two pages of bert.pdf. A bar that only steps at boundaries yields a handful of
 * distinct values; one that interpolates yields a rising series.
 *
 *   node tools/obsidian-drive.mjs run-file tools/bar-probe.js
 */
const s = window.__reflow.settings();
s.outputFolder = "bar-test";
s.maxPages = 2;

const p = window.__reflow.convertPath("bert.pdf");
let result = null;
p.then((r) => (result = r)).catch((e) => (result = { threw: String(e?.message ?? e) }));

const samples = [];
const t0 = Date.now();
for (let i = 0; i < 60 && !result; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const bar = document.querySelector(".modal progress");
  const status = document.querySelector(".modal p");
  samples.push({
    sec: Math.round((Date.now() - t0) / 1000),
    value: bar ? +bar.value.toFixed(3) : null,
    text: status?.innerText ?? null,
  });
}

const values = samples.map((x) => x.value).filter((v) => v != null);
let monotonic = true;
for (let i = 1; i < values.length; i++) if (values[i] < values[i - 1] - 1e-9) monotonic = false;

return {
  distinctValues: new Set(values).size,
  sampleCount: values.length,
  monotonic,
  min: Math.min(...values),
  max: Math.max(...values),
  samples,
  result,
};
