// Copy the built plugin (dist/) into an Obsidian vault's plugins folder.
// No rebuild — run `npm run build` first (or `npm run deploy` to do both).
//
// Vault: $OBSIDIAN_VAULT, else argv[2], else the default below.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "pdf-to-md";
const DEFAULT_VAULT = join(
  homedir(),
  "Library/Mobile Documents/iCloud~md~obsidian/Documents/Aleph",
);

const vault = process.env.OBSIDIAN_VAULT || process.argv[2] || DEFAULT_VAULT;
const dest = join(vault, ".obsidian", "plugins", PLUGIN_ID);

if (!existsSync(join("dist", "main.js"))) {
  console.error("dist/main.js not found — run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(join(vault, ".obsidian"))) {
  console.error(`Not an Obsidian vault (no .obsidian): ${vault}`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json"]) {
  cpSync(join("dist", f), join(dest, f));
}

console.log(`Installed ${PLUGIN_ID} → ${dest}`);
console.log("In Obsidian: reload (Cmd+R) or toggle the plugin off/on to load the new build.");
