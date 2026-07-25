#!/usr/bin/env node
/**
 * The CPU half of the fixture parity run — the mirror of
 * plugin/tools/fixture-parity.mjs, judged by the same shared checks.
 *
 * Each fixture gets its **own process**. Running all four in one process (as the
 * vitest spec does) both muddies the memory numbers and slows later fixtures
 * down badly: ORT's native allocations are not fully returned by
 * `vlm.dispose()`, so RSS climbs across conversions and the last fixture ran
 * several times slower than the first. One process per fixture gives a clean
 * peak-RSS figure per document, which is what sizes the machine.
 *
 *   node tools/parity-cpu.mjs                # all four
 *   node tools/parity-cpu.mjs bert vae
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(HERE, "..");
const REPO = resolve(ENGINE, "..");
const FIXTURES = join(REPO, "fixtures");

const ALL = ["attention", "bert", "vae", "ioannidis"];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

const log = (...a) => console.error(...a);

/** RSS (MB) of a process tree rooted at `pid`. */
function treeRssMb(pid) {
  try {
    const out = execFileSync(
      "bash",
      ["-c", `ps -Ao pid,ppid,rss | awk 'NR>1' | tr -s ' '`],
      { encoding: "utf8" },
    );
    const rows = out.trim().split("\n").map((l) => l.trim().split(" ").map(Number));
    const kids = new Map();
    for (const [p, pp, rss] of rows) {
      if (!kids.has(pp)) kids.set(pp, []);
      kids.get(pp).push([p, rss]);
    }
    const byPid = new Map(rows.map(([p, , rss]) => [p, rss]));
    let total = byPid.get(pid) ?? 0;
    const stack = [pid];
    while (stack.length) {
      for (const [c, rss] of kids.get(stack.pop()) ?? []) {
        total += rss;
        stack.push(c);
      }
    }
    return Math.round(total / 1024);
  } catch {
    return null;
  }
}

const results = [];

for (const id of ids) {
  const pdf = join(FIXTURES, `${id}.pdf`);
  if (!existsSync(pdf)) {
    log(`skip ${id}: no fixture PDF`);
    continue;
  }
  const outParent = mkdtempSync(join(tmpdir(), `pdf2md-parity-${id}-`));
  log(`\n=== ${id} (CPU) ===`);

  const started = Date.now();
  const child = spawn("npx", ["tsx", join(ENGINE, "src", "cli.ts"), "convert", pdf, "--out", outParent], {
    cwd: ENGINE,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let peakRssMb = 0;
  const sampler = setInterval(() => {
    const m = treeRssMb(child.pid);
    if (m && m > peakRssMb) peakRssMb = m;
  }, 3000);

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const code = await new Promise((r) => child.on("close", r));
  clearInterval(sampler);
  const elapsedSec = Math.round((Date.now() - started) / 1000);

  if (code !== 0) {
    log(`  conversion failed (exit ${code}): ${stderr.slice(-500)}`);
    results.push({ id, ok: false, error: `exit ${code}`, elapsedSec, peakRssMb });
    continue;
  }

  // convertPdf writes meta.json next to document.md; use it for title/images.
  const metaPath = execFileSync("bash", ["-c", `ls -d ${JSON.stringify(outParent)}/*/meta.json`], {
    encoding: "utf8",
  }).trim();
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const mdPath = join(dirname(metaPath), "document.md");

  const checkProc = execFileSync(
    "npx",
    ["tsx", join(ENGINE, "tools", "check-md.ts"),
      "--id", id, "--md", mdPath,
      "--title", String(meta.title ?? ""), "--images", String(meta.images ?? 0)],
    { cwd: ENGINE, encoding: "utf8", maxBuffer: 32 << 20 },
  ).toString();
  const checks = JSON.parse(checkProc);
  const failed = checks.filter((c) => !c.ok);

  log(
    `  ${checks.length - failed.length}/${checks.length} checks | ${elapsedSec}s | ` +
      `peak RSS ${peakRssMb} MB | ${meta.pages} pages | ${meta.images} images`,
  );
  for (const f of failed) log(`    FAIL ${f.name}: ${f.detail}`);
  for (const w of meta.warnings ?? []) log(`    warn: ${w}`);

  results.push({
    id,
    ok: failed.length === 0,
    checks,
    elapsedSec,
    peakRssMb,
    pages: meta.pages,
    images: meta.images,
    markdownChars: meta.markdown_chars,
    warnings: meta.warnings,
  });
}

const outPath = join(REPO, ".obsidian-test", "parity-cpu.json");
writeFileSync(outPath, JSON.stringify(results, null, 2));
log(`\nwrote ${outPath}`);
const passed = results.filter((r) => r.ok).length;
log(`\nCPU parity: ${passed}/${results.length} fixtures passed`);
process.exit(passed === results.length ? 0 : 1);
