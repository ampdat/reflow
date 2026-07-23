/**
 * Offline unit tests for the DocTags parser + MathJax repairs. No model, no
 * network — these run in CI and are the fast spec for the pure-JS core.
 *
 * The DocTags samples below are hand-written to match granite-docling's flat
 * token grammar (title / section_header / text / formula / picture+caption /
 * page_footer / OTSL table).
 */

import { describe, expect, it } from "vitest";

import { parseDocTags } from "../src/doctags.js";
import { cleanMath, fixFormula } from "../src/mathjax.js";

const SAMPLE = [
  "<doctag>",
  "<title><loc_50><loc_20><loc_450><loc_40>Attention Is All You Need</title>",
  "<section_header_level_1><loc_50><loc_60><loc_200><loc_75>1 Introduction</section_header_level_1>",
  "<text><loc_50><loc_80><loc_450><loc_120>Recurrent models typically factor computation along the symbol positions.</text>",
  "<formula><loc_50><loc_130><loc_450><loc_160>e = mc^2</formula>",
  "<picture><loc_100><loc_170><loc_400><loc_300></picture>",
  "<caption><loc_100><loc_305><loc_400><loc_320>Figure 1: The Transformer architecture.</caption>",
  "<page_footer><loc_50><loc_480><loc_450><loc_490>Preprint. Under review.</page_footer>",
  "<otsl><loc_50><loc_350><loc_450><loc_450>",
  "<ched>Model<ched>BLEU<nl><fcel>Transformer<fcel>28.4<nl><fcel>ConvS2S<fcel>25.2<nl></otsl>",
  "</doctag>",
].join("\n");

describe("parseDocTags", () => {
  const r = parseDocTags(SAMPLE);

  it("extracts the title from the <title> block", () => {
    expect(r.title).toBe("Attention Is All You Need");
    expect(r.markdown).toContain("# Attention Is All You Need");
  });

  it("maps section_header_level_1 to ##", () => {
    expect(r.markdown).toContain("## 1 Introduction");
  });

  it("keeps body text", () => {
    expect(r.markdown).toContain("Recurrent models typically factor computation");
  });

  it("emits block math", () => {
    expect(r.markdown).toContain("$$e = mc^2$$");
  });

  it("renders the OTSL table as a Markdown table with faithful numbers", () => {
    expect(r.markdown).toContain("| Model | BLEU |");
    expect(r.markdown).toContain("| Transformer | 28.4 |");
    expect(r.markdown).toContain("| ConvS2S | 25.2 |");
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]!.flat()).toContain("28.4");
  });

  it("embeds the figure with its caption and records the bbox", () => {
    expect(r.figures).toHaveLength(1);
    expect(r.figures[0]!.caption).toContain("The Transformer architecture");
    expect(r.figures[0]!.bbox).not.toBeNull();
    expect(r.markdown).toContain("![Figure 1: The Transformer architecture.](images/figure-1.png)");
  });

  it("drops running header/footer junk", () => {
    expect(r.markdown).not.toContain("Preprint. Under review.");
  });

  it("continues figure numbering from figureStart", () => {
    const r2 = parseDocTags("<picture><loc_0><loc_0><loc_10><loc_10></picture>", 4);
    expect(r2.figures[0]!.id).toBe("figure-5");
  });

  it("flags dropped merged cells rather than emitting silently-wrong tables", () => {
    const spanned = parseDocTags(
      "<otsl><fcel>A<lcel><nl><fcel>B<fcel>C<nl></otsl>",
    );
    expect(spanned.droppedSpans).toBe(true);
  });
});

describe("MathJax repairs", () => {
  it("balances truncated braces", () => {
    expect(fixFormula("a_{b")).toBe("a_{b}");
    expect(fixFormula("a}")).toBe("{a}");
  });

  it("converts trailing equation numbers to \\tag", () => {
    expect(fixFormula("x = y & & (3)")).toContain("\\tag{3}");
  });

  it("wraps stray alignment markers in aligned", () => {
    const out = fixFormula("a & b \\\\ c & d");
    expect(out.startsWith("\\begin{aligned}")).toBe(true);
    expect(out.endsWith("\\end{aligned}")).toBe(true);
  });

  it("leaves an already-enclosed environment alone", () => {
    const src = "\\begin{aligned} a & b \\end{aligned}";
    expect(fixFormula(src)).toBe(src);
  });

  it("repairs every block in a document", () => {
    expect(cleanMath("text $$a_{b$$ more")).toBe("text $$a_{b}$$ more");
  });
});
