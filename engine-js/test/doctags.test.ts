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
import { cleanMath, fixFormula, formulaLooksTruncated } from "../src/mathjax.js";

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

  it("records the formula's bbox and LaTeX without changing the Markdown", () => {
    expect(r.formulas).toHaveLength(1);
    expect(r.formulas[0]!.id).toBe("formula-1");
    expect(r.formulas[0]!.tex).toBe("e = mc^2");
    // The bbox is what lets an export target crop the equation out of the page
    // raster instead of re-rendering the model's transcription of it.
    expect(r.formulas[0]!.bbox).not.toBeNull();
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

  it("continues formula numbering from formulaStart", () => {
    const r2 = parseDocTags("<formula><loc_0><loc_0><loc_10><loc_10>x = 1</formula>", 0, 7);
    expect(r2.formulas[0]!.id).toBe("formula-8");
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

/**
 * The cases here are the real transcriptions from the `attention` fixture — two
 * that the model truncated and three it got whole. They are the spec: brace
 * repair deliberately hides truncation, so this is the only thing standing
 * between a reader and a clean-looking, wrong equation.
 */
describe("truncated-formula detection", () => {
  it("flags an equation cut off inside a function call", () => {
    expect(
      formulaLooksTruncated(
        "\\ A t t e n t i o n ( Q , K , V ) = \\text {softmax} ( \\frac { Q K ^ { T } } { \\sqrt { d _ { k } } }",
      ),
    ).toBe(true);
  });

  it("flags an equation cut off mid-number", () => {
    expect(formulaLooksTruncated("P E _ { ( p o s , 2 i ) } = \\sin ( p o s / 1 0 0 0")).toBe(true);
  });

  it("leaves complete equations alone", () => {
    expect(
      formulaLooksTruncated("F F N ( x ) = \\max ( 0 , x W _ { 1 } + b _ { 1 } ) W _ { 2 } + b _ { 2 }"),
    ).toBe(false);
    expect(formulaLooksTruncated("\\begin{aligned}a = b \\\\ c = d\\end{aligned}")).toBe(false);
    expect(formulaLooksTruncated("e = mc^2")).toBe(false);
  });

  it("treats an escaped delimiter as a literal, not a grouping", () => {
    expect(formulaLooksTruncated("f \\( x \\)")).toBe(false);
    expect(formulaLooksTruncated("[ 0 , 1 ]")).toBe(false);
  });
});
