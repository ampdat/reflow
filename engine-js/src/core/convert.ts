/**
 * Platform-agnostic document assembly: page loop → DocTags → Markdown package.
 * No filesystem, no DOM — takes an injected PageSource + Vlm and returns the
 * markdown + figure bytes for the caller (Node CLI or Obsidian plugin) to write.
 *
 * This is the whole conversion pipeline minus I/O; both runtimes share it, so
 * the fixture-validated behaviour is identical everywhere.
 */

import { parseDocTags } from "../doctags.js";
import { frontmatter } from "../frontmatter.js";
import { cleanMath } from "../mathjax.js";
import { warnImageOnly } from "../meta.js";
import type { AssembledDocument, AssembledFigure, PageSource, Vlm } from "./types.js";

/**
 * A tick a host UI can render. Conversion is minutes long and page-granular, so
 * "started" and "finished" are not enough information to show a user — without
 * these the only honest UI is a spinner.
 */
export type ConvertProgress =
  | { phase: "render"; page: number; pageCount: number }
  | { phase: "generate"; page: number; pageCount: number }
  | { phase: "page-done"; page: number; pageCount: number; ms: number; genTokens: number };

/** Thrown when `signal` aborts. `name` follows the DOM convention. */
export function abortError(): Error {
  const err = new Error("conversion cancelled");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: { aborted: boolean }): void {
  if (signal?.aborted) throw abortError();
}

export interface AssembleOptions {
  /** Process at most this many pages (0/undefined = all). */
  maxPages?: number;
  /** Value written into frontmatter `source`. */
  sourceLabel: string;
  /** Title used when the model emits none. */
  titleFallback: string;
  /** Recorded in frontmatter/meta symmetry; the VLM always transcribes formulas. */
  ocr?: boolean;
  /** ISO date for frontmatter `created`; defaults to today. */
  created?: string;
  /** Per-page progress for a host UI. */
  onProgress?: (p: ConvertProgress) => void;
  /**
   * Cancellation. Checked between pages here; pass the same signal to the VLM so
   * a cancel also interrupts a generation already running (see `createGuard`).
   */
  signal?: { aborted: boolean };
}

export async function assembleDocument(
  pages: PageSource,
  vlm: Vlm,
  opts: AssembleOptions,
): Promise<AssembledDocument> {
  const lastPage = opts.maxPages ? Math.min(pages.pageCount, opts.maxPages) : pages.pageCount;

  const bodyParts: string[] = [];
  const figures: AssembledFigure[] = [];
  const pageWarnings: string[] = [];
  let title: string | null = null;
  let figCount = 0;
  let droppedSpans = false;
  let inference = 0;
  const perPage: Array<{ page: number; ms: number; genTokens: number; tokensPerSec: number }> = [];

  for (let p = 1; p <= lastPage; p++) {
    throwIfAborted(opts.signal);
    opts.onProgress?.({ phase: "render", page: p, pageCount: lastPage });
    const page = await pages.renderPage(p);
    opts.onProgress?.({ phase: "generate", page: p, pageCount: lastPage });

    const t0 = Date.now();
    const { docTags, truncated, genTokens } = await vlm.pageToDocTags(
      page.rgba,
      page.width,
      page.height,
    );
    const pageMs = Date.now() - t0;
    inference += pageMs;
    // Per-page, not just the total. This series was added to chase an apparent
    // "cost per page climbs steeply on WebGPU"; measured properly (token-capped,
    // so every page does identical work) it is flat — 8 pages within ±4% and RSS
    // within 2%. The real fault was the rAF render stall in browser/pdf.ts: a
    // page that never finishes reads as an infinitely expensive one. Kept
    // because it is what distinguishes those two, and it is cheap.
    perPage.push({ page: p, ms: pageMs, genTokens, tokensPerSec: +(genTokens / (pageMs / 1000)).toFixed(2) });
    // After generation, not before: a cancel lands inside `generate()` via the
    // guard, so the abort is only observable once it returns.
    throwIfAborted(opts.signal);
    opts.onProgress?.({ phase: "page-done", page: p, pageCount: lastPage, ms: pageMs, genTokens });

    if (truncated) {
      pageWarnings.push(`page ${p}: generation stopped early (${truncated}) — output may be incomplete`);
    }

    const parsed = parseDocTags(docTags, figCount);
    if (title === null) title = parsed.title;
    droppedSpans = droppedSpans || parsed.droppedSpans;

    for (const fig of parsed.figures) {
      figures.push({ id: fig.id, page: p, png: fig.bbox ? await page.crop(fig.bbox) : null });
      figCount++;
    }
    bodyParts.push(parsed.markdown);
  }

  const tAssemble = Date.now();
  const finalTitle = (title && title.trim()) || opts.titleFallback;
  const body = cleanMath(bodyParts.join("\n\n"));
  const fm = frontmatter({
    title: finalTitle,
    source: opts.sourceLabel,
    pages: pages.pageCount,
    author: pages.meta.author,
    published: pages.meta.published,
    description: pages.meta.description,
    created: opts.created,
  });
  const markdown = fm + body;

  const warnings = [...pageWarnings, ...warnImageOnly(markdown.length, lastPage, opts.ocr ?? false)];
  if (droppedSpans) {
    warnings.push("table contained merged cells rendered blank — verify against source");
  }
  if (lastPage < pages.pageCount) {
    warnings.push(`processed only ${lastPage} of ${pages.pageCount} pages (--max-pages)`);
  }

  return {
    title: finalTitle,
    markdown,
    figures,
    pageCount: pages.pageCount,
    pagesProcessed: lastPage,
    warnings,
    model: vlm.modelLabel,
    executionProviders: vlm.executionProviders,
    timings: { inference, assemble: Date.now() - tAssemble, perPage },
  };
}
