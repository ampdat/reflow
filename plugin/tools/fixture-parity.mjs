#!/usr/bin/env node
/**
 * Run the 4-fixture ground-truth suite through the **WebGPU** path, inside a real
 * Obsidian, and judge it with the *same* checks the Node/CPU vitest suite uses
 * (engine-js/src/testing/fixture-checks.ts). Parity only means something if both
 * backends are measured by identical code.
 *
 * Also samples memory, since that decides the plugin's machine requirements:
 * the JS heap is only part of the story — model weights and ORT/WebGPU buffers
 * live in the renderer and GPU processes — so RSS of Obsidian's own processes is
 * sampled from outside while each conversion runs.
 *
 *   node tools/fixture-parity.mjs                # all four fixtures
 *   node tools/fixture-parity.mjs attention vae  # a subset
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const FIXTURES = join(REPO, "fixtures");
const VAULT = process.env.PDF2MD_TEST_VAULT || join(REPO, ".obsidian-test", "vault");
const DRIVE = join(HERE, "obsidian-drive.mjs");

const ALL = ["attention", "bert", "vae", "ioannidis"];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

const log = (...a) => console.error(...a);

/** Total RSS (MB) of the isolated Obsidian instance's processes. */
function obsidianRssMb() {
  try {
    const out = execFileSync(
      "bash",
      ["-c", `ps -Ao rss,command | grep '[u]ser-data-dir=${join(REPO, ".obsidian-test")}' | awk '{s+=$1} END {print s}'`],
      { encoding: "utf8" },
    ).trim();
    return Math.round(Number(out || 0) / 1024);
  } catch {
    return null;
  }
}

/** Evaluate JS in the renderer via the driver (short calls only). */
function drive(cmd, expression) {
  const r = spawnSync("node", [DRIVE, cmd, expression], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`drive ${cmd} failed: ${r.stderr?.slice(-800)}`);
  return r.stdout.trim();
}

const results = [];

for (const id of ids) {
  const pdf = join(FIXTURES, `${id}.pdf`);
  if (!existsSync(pdf)) {
    log(`skip ${id}: no fixture PDF`);
    continue;
  }
  // Stage the fixture in the vault under a stable name.
  copyFileSync(pdf, join(VAULT, `${id}.pdf`));

  const rssBefore = obsidianRssMb();
  log(`\n=== ${id} (WebGPU) — vault RSS before: ${rssBefore} MB ===`);

  // Sample RSS while the conversion runs; the peak is what sizes the machine.
  let peakRss = rssBefore ?? 0;
  const sampler = setInterval(() => {
    const m = obsidianRssMb();
    if (m && m > peakRss) peakRss = m;
  }, 3000);

  const started = Date.now();
  let summary;
  try {
    summary = JSON.parse(
      drive(
        "run",
        `const s = __reflow.settings();
         s.maxPages = 0; s.perPageTimeoutSec = 600; s.outputFolder = "out-${id}";
         const r = await __reflow.convertPath(${JSON.stringify(`${id}.pdf`)});
         return { ...r, heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null };`,
      ),
    );
  } catch (e) {
    clearInterval(sampler);
    log(`  ERROR: ${e.message}`);
    results.push({ id, ok: false, error: e.message });
    continue;
  }
  clearInterval(sampler);
  const elapsedSec = Math.round((Date.now() - started) / 1000);

  if (!summary.ok) {
    log(`  conversion failed: ${summary.error}`);
    results.push({ id, ok: false, error: summary.error, elapsedSec });
    continue;
  }

  // The plugin writes <outputFolder>/<pdf-stem>/<pdf-stem>.md inside the vault
  // and hands back the path, so this harness never rebuilds it.
  const mdPath = join(VAULT, summary.mdPath);
  if (!existsSync(mdPath)) {
    results.push({ id, ok: false, error: `no markdown at ${mdPath}`, elapsedSec });
    continue;
  }

  // Judge with the shared checks (run via tsx so the TS module is the source of truth).
  const checkOut = spawnSync(
    "npx",
    [
      "tsx",
      join(REPO, "engine-js", "tools", "check-md.ts"),
      "--id", id,
      "--md", mdPath,
      "--title", String(summary.title ?? ""),
      "--images", String(summary.figures ?? 0),
    ],
    { encoding: "utf8", cwd: join(REPO, "engine-js"), maxBuffer: 32 << 20 },
  );
  if (!checkOut.stdout) throw new Error(`check-md produced no output: ${checkOut.stderr?.slice(-800)}`);
  const checks = JSON.parse(checkOut.stdout);

  const failed = checks.filter((c) => !c.ok);
  log(
    `  ${checks.length - failed.length}/${checks.length} checks | ${elapsedSec}s | ` +
      `peak RSS ${peakRss} MB (delta ${peakRss - (rssBefore ?? 0)}) | JS heap ${summary.heapMb} MB`,
  );
  for (const f of failed) log(`    FAIL ${f.name}: ${f.detail}`);

  results.push({
    id,
    ok: failed.length === 0,
    checks,
    elapsedSec,
    warnings: summary.warnings,
    markdownChars: summary.markdownChars,
    figures: summary.figures,
    peakRssMb: peakRss,
    rssBeforeMb: rssBefore,
    jsHeapMb: summary.heapMb,
  });
}

const outPath = join(REPO, ".obsidian-test", "parity-webgpu.json");
writeFileSync(outPath, JSON.stringify(results, null, 2));
log(`\nwrote ${outPath}`);

const passed = results.filter((r) => r.ok).length;
log(`\nWebGPU parity: ${passed}/${results.length} fixtures passed`);
process.exit(passed === results.length ? 0 : 1);
