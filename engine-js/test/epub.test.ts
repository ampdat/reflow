/**
 * Offline unit tests for the EPUB builder. No model, no network, no filesystem —
 * `buildEpub` takes the note text and an asset callback, so a whole book can be
 * built in memory.
 *
 * The maths cases are the point. Everything else in an EPUB either validates or
 * does not, and epubcheck says which; the maths is where we make judgement calls
 * about what can be rendered honestly without shipping a renderer.
 */

import { describe, expect, it } from "vitest";

import { buildEpub, trivialMathToXhtml } from "../src/epub.js";

const NOTE = ["---", 'title: "Test note"', "---", "", "## Section", "", "Body text.", ""].join("\n");

const build = (markdown: string, formulas?: Parameters<typeof buildEpub>[0]["formulas"]) =>
  buildEpub({
    markdown,
    titleFallback: "test",
    formulas,
    readAsset: (rel) =>
      Promise.resolve(rel.endsWith(".png") ? new Uint8Array([0x89, 0x50, 0x4e, 0x47]) : null),
  });

describe("trivial maths → HTML", () => {
  it("handles the shape the VLM emits (base outside the maths)", () => {
    expect(trivialMathToXhtml("_{t}")).toBe("<sub>t</sub>");
    expect(trivialMathToXhtml("^{*}")).toBe("<sup>*</sup>");
  });

  it("handles the shape a human types (base inside the maths)", () => {
    expect(trivialMathToXhtml("h_t")).toBe("<em>h</em><sub>t</sub>");
    expect(trivialMathToXhtml("h_{t-1}")).toBe("<em>h</em><sub>t-1</sub>");
    expect(trivialMathToXhtml("d_{model}")).toBe("<em>d</em><sub>model</sub>");
    expect(trivialMathToXhtml("x^2")).toBe("<em>x</em><sup>2</sup>");
    expect(trivialMathToXhtml("x_i^2")).toBe("<em>x</em><sub>i</sub><sup>2</sup>");
  });

  it("refuses anything it cannot render honestly", () => {
    // Commands, operators, nested braces, repeated scripts: all real maths.
    expect(trivialMathToXhtml("\\alpha + \\beta")).toBeNull();
    expect(trivialMathToXhtml("\\frac{a}{b}")).toBeNull();
    expect(trivialMathToXhtml("a_{b_{c}}")).toBeNull();
    expect(trivialMathToXhtml("x_i_j")).toBeNull();
    expect(trivialMathToXhtml("E = mc^2")).toBeNull();
  });
});

describe("display formulas", () => {
  it("uses the crop when the sidecar has one", async () => {
    const r = await build(`${NOTE}\n$$e = mc^2$$\n`, [
      { id: "formula-1", tex: "e = mc^2", page: 1 },
    ]);
    expect(r.formulasAsCrop).toBe(1);
    expect(r.formulasAsText).toBe(0);
  });

  it("says so, rather than dropping a bare code span, when there is no crop", async () => {
    const r = await build(`${NOTE}\n$$e = mc^2$$\n`);
    expect(r.formulasAsCrop).toBe(0);
    expect(r.formulasAsText).toBe(1);
    expect(r.warnings.join(" ")).toContain("could not be rendered");
  });

  it("does not use a crop whose LaTeX no longer matches the note", async () => {
    // The reader edited the equation after conversion; the crop is now a
    // picture of something else, which is worse than showing the source.
    const r = await build(`${NOTE}\n$$e = mc^3$$\n`, [
      { id: "formula-1", tex: "e = mc^2", page: 1 },
    ]);
    expect(r.formulasAsCrop).toBe(0);
    expect(r.formulasAsText).toBe(1);
  });

  it("keys crops by position, so repeated LaTeX still maps one-to-one", async () => {
    const r = await build(`${NOTE}\n$$x = 1$$\n\ntext\n\n$$x = 1$$\n`, [
      { id: "formula-1", tex: "x = 1", page: 1 },
      { id: "formula-2", tex: "x = 1", page: 2 },
    ]);
    expect(r.formulasAsCrop).toBe(2);
  });
});

describe("the container", () => {
  it("puts an uncompressed `mimetype` first, as EPUB requires", async () => {
    const { bytes } = await build(NOTE);
    // 30-byte local header + the 8-byte name, so the content starts at 38.
    const head = new TextDecoder().decode(bytes.slice(0, 60));
    expect(head).toContain("mimetype");
    expect(head).toContain("application/epub+zip");
    // Stored, not deflated: compression method 0 at offset 8.
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true)).toBe(0);
  });

  it("is byte-identical across runs", async () => {
    const [a, b] = await Promise.all([build(NOTE), build(NOTE)]);
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });

  it("reports a missing image instead of manifesting a file it never wrote", async () => {
    const r = await buildEpub({
      markdown: `${NOTE}\n![fig](images/missing.gif)\n`,
      titleFallback: "test",
      readAsset: () => Promise.resolve(null),
    });
    expect(r.images).toBe(0);
    expect(r.warnings.join(" ")).toContain("missing image");
  });
});
