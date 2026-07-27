/**
 * Does moving inference into a worker actually keep Obsidian responsive?
 *
 * Run with `node tools/obsidian-drive.mjs run-file tools/worker-probe.js`.
 *
 * The claim under test is about the *main thread*, so the instrument has to live
 * there: a 50 ms interval whose observed period is the event-loop lag. A
 * conversion that blocks the renderer shows up as a fat max and a fat p95; one
 * that doesn't shows the timer's own noise floor. Totals can't tell those apart,
 * which is why the earlier "877 ms in one run, 4.5 ms in another" reading was
 * ambiguous — it sampled a single phase, and prefill and decode block very
 * differently.
 *
 * Set PDF2MD_PROBE_MODE=renderer (below) for the control arm: the same build,
 * the same page count, the engine on the main thread.
 */

const FILE = "attention.pdf";
const PAGES = 2;

/** Sample event-loop lag on whichever thread this runs on. */
function lagSampler(periodMs = 50) {
  const lags = [];
  let last = performance.now();
  const id = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - last - periodMs));
    last = now;
  }, periodMs);
  return {
    stop() {
      clearInterval(id);
      lags.sort((a, b) => a - b);
      const at = (q) => (lags.length ? +lags[Math.min(lags.length - 1, Math.floor(q * lags.length))].toFixed(1) : null);
      return {
        samples: lags.length,
        medianMs: at(0.5),
        p95Ms: at(0.95),
        maxMs: lags.length ? +lags[lags.length - 1].toFixed(1) : null,
        /** How often the UI was blocked long enough to feel (>100 ms). */
        over100ms: lags.filter((l) => l > 100).length,
      };
    },
  };
}

const api = window.__reflow;
if (!api) throw new Error("plugin not loaded");

const mode = globalThis.PDF2MD_PROBE_MODE ?? "worker";
await api.setUseWorker(mode === "worker");

// A small page budget: this probe is about responsiveness and plumbing, not
// throughput, and a full paper would take 8 minutes to answer the same question.
const settings = api.settings();
const restore = settings.maxPages;
settings.maxPages = PAGES;

const rss = () => {
  try {
    return Math.round(process.memoryUsage().rss / 1048576);
  } catch {
    return null;
  }
};

const rssBefore = rss();
const sampler = lagSampler();
const t0 = performance.now();
let result;
try {
  result = await api.convertPath(FILE);
} finally {
  settings.maxPages = restore;
}
const lag = sampler.stop();

// ORT's native memory is the point of the disposable worker, and it is not
// returned instantly — give the terminated thread a moment before reading RSS.
await new Promise((r) => setTimeout(r, 3000));

return {
  mode,
  runMode: api.lastRunMode(),
  ok: result.ok,
  elapsedSec: Math.round((performance.now() - t0) / 1000),
  markdownChars: result.markdownChars,
  figures: result.figures,
  warnings: result.warnings,
  perPage: result.perPage,
  mainThreadLag: lag,
  rssBeforeMb: rssBefore,
  rssAfterMb: rss(),
};
