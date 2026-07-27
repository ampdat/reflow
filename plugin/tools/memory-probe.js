/**
 * Does renderer memory still climb across conversions?
 *
 * Run with `node tools/obsidian-drive.mjs run-file tools/memory-probe.js`.
 *
 * The reported failure was accumulation, not peak: RSS went 2528 → 5156 →
 * 7313 MB over successive fixtures in one process, despite the engine calling
 * `vlm.dispose()` and `pdf.destroy()`. ORT does not give all of its native
 * allocations back, so a user converting a few PDFs in one Obsidian session
 * watched the renderer grow until it died. One conversion cannot show that —
 * the shape only appears across several in the same process, which is what this
 * measures.
 *
 * Set `globalThis.PDF2MD_PROBE_MODE = "renderer"` first for the control arm.
 */

const FILE = "attention.pdf";
const PAGES = 2;
const RUNS = 3;

const api = window.__reflow;
if (!api) throw new Error("plugin not loaded");

const mode = globalThis.PDF2MD_PROBE_MODE ?? "worker";
await api.setUseWorker(mode === "worker");

const settings = api.settings();
const restore = settings.maxPages;
settings.maxPages = PAGES;

/** Renderer RSS — a worker is a thread of this process, so its memory counts. */
const rss = () => {
  try {
    return Math.round(process.memoryUsage().rss / 1048576);
  } catch {
    return null;
  }
};

const rows = [];
try {
  for (let i = 1; i <= RUNS; i++) {
    const before = rss();
    const t0 = performance.now();
    const r = await api.convertPath(FILE);
    // Terminating a worker frees its memory asynchronously; without a pause the
    // reading would credit the previous run's memory to the next one.
    await new Promise((res) => setTimeout(res, 5000));
    rows.push({
      run: i,
      ok: r.ok,
      mode: api.lastRunMode(),
      sec: Math.round((performance.now() - t0) / 1000),
      chars: r.markdownChars,
      rssBeforeMb: before,
      rssAfterMb: rss(),
    });
    console.log(`[reflow mem] run ${i}: ${before} → ${rss()} MB`);
  }
} finally {
  settings.maxPages = restore;
}

return {
  mode,
  rows,
  /** The number that matters: growth from the first baseline to the last reading. */
  netGrowthMb: rows.length ? rows[rows.length - 1].rssAfterMb - rows[0].rssBeforeMb : null,
};
