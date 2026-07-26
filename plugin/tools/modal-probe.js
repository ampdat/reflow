/**
 * Verify the conversion dialog's detach/reattach cycle and whether Obsidian
 * stays usable while a conversion runs.
 *
 * Checks, in order: the dialog ticks mid-page; closing it leaves a Notice
 * carrying the page counter; clicking that Notice brings the dialog back with
 * the elapsed clock intact; the workspace can open another note while detached;
 * and the main thread is not wedged (event-loop lag under generation).
 *
 *   node tools/obsidian-drive.mjs run-file tools/modal-probe.js
 */
const s = window.__pdf2md.settings();
s.outputFolder = "modal-test";
s.maxPages = 2; // two pages of bert.pdf — long enough to watch, short enough to rerun

const out = {};
const modalText = () => {
  const m = document.querySelector(".modal");
  return m ? m.innerText.replace(/\s+/g, " ") : null;
};
const statusEl = () =>
  [...document.querySelectorAll(".status-bar-item")].find((e) => e.innerText.includes("⏳")) ?? null;
const statusText = () => statusEl()?.innerText.replace(/\s+/g, " ") ?? null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Median delay of a 0 ms timer — how long input would sit behind the work. */
async function eventLoopLagMs(samples = 12) {
  const lags = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    await new Promise((r) => setTimeout(r, 0));
    lags.push(performance.now() - t);
  }
  lags.sort((a, b) => a - b);
  return +lags[Math.floor(lags.length / 2)].toFixed(1);
}

const p = window.__pdf2md.convertPath("bert.pdf");
let result = null;
p.then((r) => (result = r)).catch((e) => (result = { threw: String(e?.message ?? e) }));

// 1. Dialog ticks while one page generates.
await wait(20000);
const tick1 = modalText();
await wait(6000);
const tick2 = modalText();
out.ticks = { tick1, tick2, changed: tick1 !== tick2 };

// 2. Close it the way a user would (Escape) — must NOT cancel.
document.querySelector(".modal-close-button")?.click() ??
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
await wait(1500);
out.afterClose = { modal: modalText(), status: statusText(), stillRunning: result === null };

// 3. Workspace usable while detached: open another note.
const other = app.vault.getFiles().find((f) => f.extension === "md");
const tOpen = performance.now();
if (other) await app.workspace.getLeaf(true).openFile(other);
out.openedNoteWhileConverting = {
  file: other?.path ?? null,
  ms: Math.round(performance.now() - tOpen),
  activeFile: app.workspace.getActiveFile()?.path ?? null,
};
out.eventLoopLagMs = await eventLoopLagMs();

// 4. Click the status bar item — the dialog must come back, clock intact.
statusEl()?.click();
await wait(1500);
out.afterReopen = { modal: modalText(), status: statusText() };

// 5. Cancel from the reopened dialog.
const btn = [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Cancel");
const tCancel = Date.now();
btn?.click();
for (let i = 0; i < 30 && !result; i++) await wait(500);
out.cancel = { sawButton: !!btn, settledMs: Date.now() - tCancel, result };

return out;
