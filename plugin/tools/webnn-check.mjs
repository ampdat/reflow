#!/usr/bin/env node
/**
 * Run tools/webnn-probe.js in Node, so the Node answer comes from the exact
 * same probe text as the Obsidian answer (`obsidian-drive.mjs eval-file
 * tools/webnn-probe.js`). Prints the probe as JSON.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "webnn-probe.js"), "utf8");

// The probe is a bare function body ending in `return`, so build a function from it.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const result = await new AsyncFunction(src)();

console.log(JSON.stringify(result, null, 2));
