#!/usr/bin/env node
/**
 * pdf2md-js — CLI over the portable engine. Mirrors the Python `pdf2md` UX so
 * the two engines are interchangeable at the command line.
 *
 *   pdf2md-js convert paper.pdf --out out/
 *   pdf2md-js version
 */

import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";

import { convertPdf, VERSION } from "./index.js";

async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(
      "usage: pdf2md-js <convert|version>\n" +
        "  convert <pdf> [--out DIR] [--no-formulas] [--ocr] [--device cpu|webgpu|auto] [--dtype fp32|int8|q8|...] [--max-pages N]\n",
    );
    return command ? 0 : 2;
  }

  if (command === "version") {
    process.stdout.write(`pdf2md-js ${VERSION}\n`);
    return 0;
  }

  if (command === "convert") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        out: { type: "string", default: "out" },
        "no-formulas": { type: "boolean", default: false },
        ocr: { type: "boolean", default: false },
        device: { type: "string" },
        "max-pages": { type: "string" },
        dtype: { type: "string" },
      },
    });

    const pdfPath = positionals[0];
    if (!pdfPath) {
      process.stderr.write("error: missing PDF path\n");
      return 2;
    }
    try {
      const s = await stat(pdfPath);
      if (!s.isFile()) throw new Error("not a file");
    } catch {
      process.stderr.write(`error: no such file: ${pdfPath}\n`);
      return 2;
    }

    const device = values.device as "cpu" | "webgpu" | "auto" | undefined;
    const dtype = values.dtype as string | undefined;
    const maxPagesRaw = values["max-pages"] as string | undefined;
    const maxPages = maxPagesRaw ? Number(maxPagesRaw) : undefined;
    if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1)) {
      process.stderr.write(`error: --max-pages must be a positive integer\n`);
      return 2;
    }
    const vlm = device || dtype ? { ...(device ? { device } : {}), ...(dtype ? { dtype } : {}) } : undefined;
    const meta = await convertPdf(pdfPath, values.out as string, {
      formulas: !(values["no-formulas"] as boolean),
      ocr: values.ocr as boolean,
      maxPages,
      vlm,
    });
    process.stdout.write(
      `wrote ${meta.md_path} ` +
        `(${meta.pages} pages, ${meta.images} images, ${meta.wall_ms} ms)\n`,
    );
    return 0;
  }

  process.stderr.write(`error: unknown command: ${command}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`error: ${err?.stack || err}\n`);
    process.exit(1);
  },
);
