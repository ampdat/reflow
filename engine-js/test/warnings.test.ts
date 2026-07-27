/**
 * Offline spec for how conversion problems reach the *reader*.
 *
 * `meta.json` has always recorded warnings, but nobody reads a sidecar JSON
 * before reading a paper — so a lossy conversion produced a note that looked
 * perfectly clean. These tests pin the three things that fixed that: a banner at
 * the top, a marker at the damaged page, and a frontmatter count for querying.
 *
 * No model and no PDF: `assembleDocument` takes an injected PageSource and Vlm,
 * so the whole page loop can be driven from fakes.
 */

import { describe, expect, it } from "vitest";

import { assembleDocument } from "../src/core/convert.js";
import type { PageResult, PageSource, Vlm } from "../src/core/types.js";

/** DocTags with enough prose that the image-only heuristic stays quiet. */
function pageTags(n: number): string {
  return (
    `<doctag><text><loc_10><loc_10><loc_400><loc_40>Page ${n} body text. ` +
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod " +
    "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, " +
    "quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo.</text></doctag>"
  );
}

/** An OTSL table using a column span, which the parser renders blank. */
const SPAN_TABLE =
  "<doctag><otsl><loc_10><loc_10><loc_400><loc_200>" +
  "<ched>Model<ched>BLEU<nl><fcel>Transformer<lcel><nl></otsl></doctag>";

function fakePages(count: number): PageSource {
  return {
    pageCount: count,
    meta: {},
    async renderPage(index) {
      return {
        index,
        width: 10,
        height: 10,
        rgba: new Uint8ClampedArray(400),
        textTokens: [],
        async crop() {
          return new Uint8Array([1]);
        },
      };
    },
    async destroy() {},
  };
}

/** Returns `truncated` for the pages named, and the given DocTags per page. */
function fakeVlm(tagsFor: (p: number) => string, truncateOn: Record<number, string> = {}): Vlm {
  let page = 0;
  return {
    modelLabel: "fake@fp32",
    executionProviders: ["cpu"],
    async pageToDocTags(): Promise<PageResult> {
      page += 1;
      return {
        docTags: tagsFor(page),
        truncated: truncateOn[page] ?? null,
        genTokens: 100,
        promptTokens: 10,
      };
    },
    dispose() {},
  };
}

const BASE = { sourceLabel: "paper.pdf", titleFallback: "paper", created: "2026-01-01" };

describe("reader-facing conversion warnings", () => {
  it("says nothing at all when the conversion is clean", async () => {
    const doc = await assembleDocument(fakePages(2), fakeVlm(pageTags), BASE);

    expect(doc.warnings).toEqual([]);
    expect(doc.markdown).not.toContain("[!warning]");
    // A clean note must not gain a property either — an always-present
    // `conversion_warnings: 0` would be noise in every paper in the vault.
    expect(doc.markdown).not.toContain("conversion_warnings");
  });

  it("banners the warnings at the top and counts them in frontmatter", async () => {
    const doc = await assembleDocument(
      fakePages(3),
      fakeVlm(pageTags, { 2: "repetition" }),
      BASE,
    );

    expect(doc.markdown).toContain("conversion_warnings: 1");
    expect(doc.markdown).toContain("> [!warning]+ Conversion warnings (1)");
    expect(doc.markdown).toContain("> - page 2: generation stopped early (repetition)");

    // The banner belongs between the frontmatter and the body: after the closing
    // `---`, and before any converted content.
    const banner = doc.markdown.indexOf("[!warning]+");
    expect(banner).toBeGreaterThan(doc.markdown.lastIndexOf("---"));
    expect(banner).toBeLessThan(doc.markdown.indexOf("Page 1 body text"));
  });

  it("marks the damaged page inline, where the reader meets it", async () => {
    const doc = await assembleDocument(
      fakePages(3),
      fakeVlm(pageTags, { 2: "timeout" }),
      BASE,
    );

    const marker = "> [!warning] Page 2 may be incomplete";
    expect(doc.markdown).toContain(marker);
    // Between page 2's text and page 3's — a summary at the top cannot locate
    // the damage, because reflowed markdown has no page boundaries.
    const at = doc.markdown.indexOf(marker);
    expect(at).toBeGreaterThan(doc.markdown.indexOf("Page 2 body text"));
    expect(at).toBeLessThan(doc.markdown.indexOf("Page 3 body text"));
  });

  it("names the pages whose tables lost merged cells, and marks them inline", async () => {
    const doc = await assembleDocument(
      fakePages(2),
      fakeVlm((p) => (p === 2 ? SPAN_TABLE : pageTags(p))),
      BASE,
    );

    expect(doc.warnings.join("\n")).toContain("on page 2 contained merged cells");
    expect(doc.markdown).toContain("a table here had merged cells that render blank");
  });

  it("reports both faults on one page in a single marker", async () => {
    const doc = await assembleDocument(
      fakePages(1),
      fakeVlm(() => SPAN_TABLE, { 1: "repetition" }),
      BASE,
    );

    const line = doc.markdown
      .split("\n")
      .find((l) => l.startsWith("> [!warning] Page 1"));
    expect(line).toContain("generation stopped early (repetition)");
    expect(line).toContain("merged cells");
  });
});
