/**
 * pdf2md portable engine (TypeScript + ONNX) — Node entry.
 *
 * Public API: convertPdf(pdfPath, outParent, opts) -> Meta.
 * Produces the frozen artifact contract — out/<Title>/document.md + images/ +
 * meta.json — identical to the Python bootstrap, labelled engine "onnx-portable".
 *
 * The conversion pipeline itself lives in core/convert.ts (platform-agnostic);
 * this file is the Node adapter: pdf.js via @napi-rs/canvas, onnxruntime-node
 * VLM, and filesystem writes. The Obsidian/browser build reuses the same core.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { assembleDocument } from "./core/convert.js";
import { sanitizeDirname } from "./frontmatter.js";
import { ENGINE_ID, type Meta } from "./meta.js";
import { loadPdf } from "./pdf.js";
import { loadVlm, type VlmOptions } from "./vlm.js";

export const VERSION = "0.1.0";

export interface ConvertOptions {
  /** VLM always transcribes formulas; kept for contract symmetry / meta record. */
  formulas?: boolean;
  ocr?: boolean;
  /** Process at most this many pages (iteration/smoke-test knob; 0/undefined = all). */
  maxPages?: number;
  vlm?: VlmOptions;
}

export async function convertPdf(
  pdfPath: string,
  outParent: string,
  opts: ConvertOptions = {},
): Promise<Meta> {
  const t0 = Date.now();
  const formulas = opts.formulas ?? true;
  const ocr = opts.ocr ?? false;

  const bytes = await readFile(pdfPath);
  const pdf = await loadPdf(new Uint8Array(bytes));
  const loadMs = Date.now() - t0;
  const vlm = await loadVlm(opts.vlm);

  const fallback = basename(pdfPath, extname(pdfPath));
  let doc;
  try {
    doc = await assembleDocument(pdf, vlm, {
      maxPages: opts.maxPages,
      sourceLabel: resolve(pdfPath),
      titleFallback: fallback,
      ocr,
    });
  } finally {
    vlm.dispose();
    await pdf.destroy();
  }

  const outDir = join(outParent, sanitizeDirname(doc.title) || fallback);
  const imagesDir = join(outDir, "images");
  await mkdir(imagesDir, { recursive: true });

  let imageCount = 0;
  for (const fig of doc.figures) {
    if (!fig.png) continue;
    await writeFile(join(imagesDir, `${fig.id}.png`), fig.png);
    imageCount++;
  }

  await writeFile(join(outDir, "document.md"), doc.markdown, "utf-8");

  const meta: Meta = {
    source: pdfPath,
    title: doc.title,
    out_dir: outDir,
    engine: ENGINE_ID,
    engine_version: VERSION,
    model: doc.model,
    options: { formulas, ocr },
    pages: doc.pageCount,
    images: imageCount,
    markdown_chars: doc.markdown.length,
    timings_ms: { load: loadMs, inference: doc.timings.inference, assemble: doc.timings.assemble },
    wall_ms: Date.now() - t0,
    execution_providers: doc.executionProviders,
    warnings: doc.warnings,
  };
  await writeFile(join(outDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

  for (const w of doc.warnings) process.stderr.write(`WARNING: ${w}\n`);
  return meta;
}

export { assembleDocument } from "./core/convert.js";
export { parseDocTags } from "./doctags.js";
export { cleanMath, fixFormula } from "./mathjax.js";
export type { Meta } from "./meta.js";
export type { AssembledDocument, PageSource, Vlm } from "./core/types.js";
