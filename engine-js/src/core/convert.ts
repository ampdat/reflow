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
    const page = await pages.renderPage(p);

    const t0 = Date.now();
    const { docTags, truncated, genTokens } = await vlm.pageToDocTags(
      page.rgba,
      page.width,
      page.height,
    );
    const pageMs = Date.now() - t0;
    inference += pageMs;
    // Per-page, not just the total: on WebGPU the cost per page climbs steeply
    // through a document (a 2-page run looks fine while a 15-page run does not),
    // and only a per-page series makes that visible.
    perPage.push({ page: p, ms: pageMs, genTokens, tokensPerSec: +(genTokens / (pageMs / 1000)).toFixed(2) });

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
