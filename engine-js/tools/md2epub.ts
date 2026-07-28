#!/usr/bin/env node
/**
 * CLI over the EPUB builder — the Node half of what the plugin does in-vault.
 *
 * Takes a converted package (`<stem>/<stem>.md` + `images/` + `meta.json`) and
 * writes `<stem>.epub` beside it. All the work is in src/epub.ts; this is just
 * filesystem plumbing, so the CLI and the plugin cannot drift apart.
 *
 *   npx tsx tools/md2epub.ts <package-dir|file.md> [--out x.epub]
 *
 * This replaces the `md2epub.mjs` spike prototype. That file also carried
 * `--math svg|png|auto` modes which rendered formulas with MathJax; they existed
 * to price a maths renderer against the crops, that question is answered in
 * docs/spike-epub.md §7, and shipping kept only the winner.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { statSync } from "node:fs";

import { buildEpub, type FormulaSidecar } from "../src/epub.js";

async function main(argv: string[]): Promise<number> {
  const args: { input?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (!argv[i]!.startsWith("--")) args.input = argv[i];
  }
  if (!args.input) {
    process.stderr.write("usage: md2epub.ts <package-dir|file.md> [--out x.epub]\n");
    return 2;
  }

  const input = resolve(args.input);
  let mdPath = input;
  if (statSync(input).isDirectory()) {
    const md = (await readdir(input)).filter((f) => f.endsWith(".md"));
    if (!md.length) {
      process.stderr.write(`error: no .md in ${input}\n`);
      return 2;
    }
    mdPath = join(input, md[0]!);
  }
  const pkgDir = dirname(mdPath);
  const outPath = args.out ?? join(pkgDir, `${basename(mdPath, ".md")}.epub`);

  // The sidecar is optional: a note written by hand, or a package converted
  // before crops existed, simply exports its equations as LaTeX source.
  let formulas: FormulaSidecar[] | undefined;
  try {
    const meta = JSON.parse(await readFile(join(pkgDir, "meta.json"), "utf8")) as {
      formulas?: FormulaSidecar[];
    };
    formulas = meta.formulas;
  } catch {
    formulas = undefined;
  }

  const t0 = Date.now();
  const result = await buildEpub({
    markdown: await readFile(mdPath, "utf8"),
    titleFallback: basename(mdPath, ".md"),
    formulas,
    readAsset: async (rel) => {
      try {
        return new Uint8Array(await readFile(join(pkgDir, rel)));
      } catch {
        return null;
      }
    },
  });
  await writeFile(outPath, result.bytes);

  process.stdout.write(
    JSON.stringify(
      {
        out: outPath,
        ms: Date.now() - t0,
        kb: +(result.bytes.length / 1024).toFixed(1),
        chapters: result.chapters,
        images: result.images,
        formulas: { asCrop: result.formulasAsCrop, asText: result.formulasAsText },
        inlineAsText: result.inlineAsText,
        warnings: result.warnings,
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

process.exit(await main(process.argv.slice(2)));
