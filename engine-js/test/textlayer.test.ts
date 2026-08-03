import { describe, expect, it } from "vitest";
import { textLayerParagraphs } from "../src/core/textlayer.js";
import type { TextToken } from "../src/core/types.js";

/** A token on a notional 10pt line, positioned in page fractions. */
function tok(str: string, l: number, top: number, width: number, h = 0.02): TextToken {
  return { str, bbox: { l, t: top, r: l + width, b: top + h } };
}

describe("textLayerParagraphs", () => {
  it("joins runs split by typesetting without inventing spaces", () => {
    // Small caps arrive as separate runs with no gap between them: "K" then
    // "IMI". Joining every run with a space would produce "K IMI K3".
    const line = [tok("K", 0.1, 0.1, 0.02), tok("IMI", 0.12, 0.1, 0.05), tok("K3", 0.185, 0.1, 0.04)];
    expect(textLayerParagraphs(line)).toBe("KIMI K3");
  });

  it("keeps the space between words that are actually apart", () => {
    const line = [tok("Kimi", 0.1, 0.1, 0.06), tok("Team", 0.17, 0.1, 0.06)];
    expect(textLayerParagraphs(line)).toBe("Kimi Team");
  });

  it("breaks lines on vertical movement and paragraphs on a wider gap", () => {
    const tokens = [
      tok("first line", 0.1, 0.10, 0.2),
      tok("second line", 0.1, 0.125, 0.2), // tight leading — same paragraph
      tok("new paragraph", 0.1, 0.18, 0.2), // wide gap — new one
    ];
    expect(textLayerParagraphs(tokens)).toBe("first line second line\n\nnew paragraph");
  });

  it("skips text inside regions the model already cropped as pictures", () => {
    // A chart's axis labels are text in the layer and noise in a paragraph; the
    // note already shows that region as an image.
    const tokens = [
      tok("Real prose here", 0.1, 0.1, 0.3),
      tok("DeepSWE", 0.2, 0.6, 0.1),
      tok("73.0", 0.5, 0.62, 0.05),
    ];
    const chart = [{ l: 0.15, t: 0.55, r: 0.9, b: 0.8 }];
    expect(textLayerParagraphs(tokens, chart)).toBe("Real prose here");
    expect(textLayerParagraphs(tokens)).toContain("DeepSWE");
  });

  it("returns nothing for a page with no text at all", () => {
    expect(textLayerParagraphs([])).toBe("");
    expect(textLayerParagraphs([tok("   ", 0.1, 0.1, 0.05)])).toBe("");
  });

  it("ignores tokens that are only whitespace between real ones", () => {
    const tokens = [tok("alpha", 0.1, 0.1, 0.06), tok(" ", 0.17, 0.1, 0.01), tok("beta", 0.2, 0.1, 0.05)];
    expect(textLayerParagraphs(tokens)).toBe("alpha beta");
  });
});
