/**
 * pdf2md portable engine (TypeScript + ONNX).
 *
 * Public API: convertPdf(pdfPath, outParent, opts) -> Meta.
 * Produces the frozen artifact contract — out/<Title>/document.md + images/ +
 * meta.json — identical to the Python bootstrap, labelled engine "onnx-portable".
 *
 * Pipeline: pdf.js rasterizes each page -> granite-docling ONNX emits DocTags ->
 * the JS DocTags parser -> MathJax repairs -> vault package. One page in flight
 * at a time to bound memory (same shape a mobile target will need).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { parseDocTags, type FigureRef } from "./doctags.js";
import { frontmatter, sanitizeDirname } from "./frontmatter.js";
import { cleanMath } from "./mathjax.js";
import { ENGINE_ID, warnImageOnly, type Meta } from "./meta.js";
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

  const bodyParts: string[] = [];
  const allFigures: Array<FigureRef & { page: number; png: Buffer | null }> = [];
  let title: string | null = null;
  let inferenceMs = 0;
  let droppedSpans = false;

  const lastPage = opts.maxPages ? Math.min(pdf.pageCount, opts.maxPages) : pdf.pageCount;

  try {
    for (let p = 1; p <= lastPage; p++) {
      const page = await pdf.renderPage(p);

      const tInfer = Date.now();
      const docTags = await vlm.pageToDocTags(page.rgba, page.width, page.height);
      inferenceMs += Date.now() - tInfer;

      const parsed = parseDocTags(docTags, allFigures.length);
      if (title === null) title = parsed.title;
      droppedSpans = droppedSpans || parsed.droppedSpans;

      for (const fig of parsed.figures) {
        const png = fig.bbox ? page.crop(fig.bbox) : null;
        allFigures.push({ ...fig, page: p, png });
      }
      bodyParts.push(parsed.markdown);
    }
  } finally {
    vlm.dispose();
    await pdf.destroy();
  }

  const tAssemble = Date.now();

  const finalTitle = (title && title.trim()) || basename(pdfPath, extname(pdfPath));
  const outDir = join(outParent, sanitizeDirname(finalTitle) || basename(pdfPath, extname(pdfPath)));
  const imagesDir = join(outDir, "images");
  await mkdir(imagesDir, { recursive: true });

  let imageCount = 0;
  for (const fig of allFigures) {
    if (!fig.png) continue;
    await writeFile(join(imagesDir, `${fig.id}.png`), fig.png);
    imageCount++;
  }

  const body = cleanMath(bodyParts.join("\n\n"));
  const fm = frontmatter({
    title: finalTitle,
    source: resolve(pdfPath),
    pages: pdf.pageCount,
    author: pdf.meta.author,
    published: pdf.meta.published,
    description: pdf.meta.description,
  });
  const markdown = fm + body;
  await writeFile(join(outDir, "document.md"), markdown, "utf-8");

  const warnings = warnImageOnly(markdown.length, lastPage, ocr);
  if (droppedSpans) {
    warnings.push("table contained merged cells rendered blank — verify against source");
  }
  if (lastPage < pdf.pageCount) {
    warnings.push(`processed only ${lastPage} of ${pdf.pageCount} pages (--max-pages)`);
  }

  const assembleMs = Date.now() - tAssemble;
  const meta: Meta = {
    source: pdfPath,
    title: finalTitle,
    out_dir: outDir,
    engine: ENGINE_ID,
    engine_version: VERSION,
    model: vlm.modelLabel,
    options: { formulas, ocr },
    pages: pdf.pageCount,
    images: imageCount,
    markdown_chars: markdown.length,
    timings_ms: { load: loadMs, inference: inferenceMs, assemble: assembleMs },
    wall_ms: Date.now() - t0,
    execution_providers: vlm.executionProviders,
    warnings,
  };
  await writeFile(join(outDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

  for (const w of warnings) process.stderr.write(`WARNING: ${w}\n`);
  return meta;
}

export { parseDocTags } from "./doctags.js";
export { cleanMath, fixFormula } from "./mathjax.js";
export type { Meta } from "./meta.js";
