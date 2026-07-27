#!/usr/bin/env node
/**
 * Validate the root manifest.json against Obsidian's submission requirements.
 *
 * These checks belong to `eslint-plugin-obsidianmd`, which reads `manifest.json`
 * from its own working directory — and the manifest has to live at the
 * *repository* root, because that is the copy the community directory reads at
 * the HEAD of the default branch. Rather than keep a second manifest next to the
 * source for the linter to be happy about, and watch the two drift, the handful
 * of rules that actually reject a submission are asserted here.
 *
 *   node check-manifest.mjs            # validate
 *   node check-manifest.mjs 0.2.0      # validate, and require this exact version
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const versions = JSON.parse(readFileSync(join(ROOT, "versions.json"), "utf8"));
const expectedVersion = process.argv[2];

const errors = [];
const check = (ok, message) => {
  if (!ok) errors.push(message);
};

for (const field of ["id", "name", "version", "minAppVersion", "description", "author"]) {
  check(typeof manifest[field] === "string" && manifest[field].length > 0, `${field} is required`);
}

check(!/obsidian/i.test(manifest.id ?? ""), "id must not contain 'obsidian'");
check(/^[a-z0-9-]+$/.test(manifest.id ?? ""), "id should be lowercase, digits and dashes");
check(!/^obsidian/i.test(manifest.name ?? ""), "name should not start with 'Obsidian'");
check(/^\d+\.\d+\.\d+$/.test(manifest.version ?? ""), "version must be semver x.y.z");
check(/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion ?? ""), "minAppVersion must be x.y.z");

const d = manifest.description ?? "";
check(d.length <= 250, `description must be 250 characters or fewer (is ${d.length})`);
check(d.endsWith("."), "description must end with a period");
check(!/^(this is a |this plugin|a plugin)/i.test(d), "description must not start with 'This is a plugin'");
// eslint-disable-next-line no-control-regex -- deliberately matching non-ASCII
check(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(d), "description must not contain emoji");

check("fundingUrl" in manifest === false || !!manifest.fundingUrl, "remove fundingUrl if unused");
check(manifest.isDesktopOnly === true, "isDesktopOnly must be true — this plugin reads Electron's process");

check(
  versions[manifest.version] === manifest.minAppVersion,
  `versions.json must map ${manifest.version} to ${manifest.minAppVersion}`,
);

if (expectedVersion) {
  check(
    manifest.version === expectedVersion,
    `release tag ${expectedVersion} does not match manifest version ${manifest.version}`,
  );
}

if (errors.length) {
  console.error("manifest.json does not meet Obsidian's submission requirements:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`manifest.json ok — ${manifest.id} ${manifest.version} (minAppVersion ${manifest.minAppVersion})`);
