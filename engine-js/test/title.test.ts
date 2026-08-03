import { describe, expect, it } from "vitest";
import { chooseTitle, looksLikeSectionHeading, usableMetadataTitle } from "../src/core/title.js";

describe("chooseTitle", () => {
  it("prefers the PDF's own metadata over a heading read off the page", () => {
    // The case this was written for: the model's transcription of a small-caps
    // title page, next to what the LaTeX pipeline actually wrote.
    expect(
      chooseTitle({
        metadata: "Audio Effect Estimation with DNN-Based Prediction and Search Algorithm",
        firstPageHeading: "AUDIO EFFECT ESTIMATION WITH DNN-BASED PREDICTION AND SEARCH ALGORITHM",
        fallback: "2604.22276v1",
      }),
    ).toBe("Audio Effect Estimation with DNN-Based Prediction and Search Algorithm");
  });

  it("rescues a paper whose title page came back as nothing but pictures", () => {
    // Real failure: page 1 produced two figures and no text, so the first
    // heading in the whole document was page 2's section header.
    expect(
      chooseTitle({
        metadata: "Kimi K3: Open Frontier Intelligence",
        firstPageHeading: null,
        fallback: "2607.24653v1",
      }),
    ).toBe("Kimi K3: Open Frontier Intelligence");
  });

  it("falls back to the heading when the PDF carries no metadata title", () => {
    expect(
      chooseTitle({ metadata: "", firstPageHeading: "Attention Is All You Need", fallback: "attention" }),
    ).toBe("Attention Is All You Need");
    expect(
      chooseTitle({ firstPageHeading: "Auto-Encoding Variational Bayes", fallback: "vae" }),
    ).toBe("Auto-Encoding Variational Bayes");
  });

  it("falls back to the heading when the metadata is the producer's filename", () => {
    expect(
      chooseTitle({
        metadata: "PLME0208_696-701.indd",
        firstPageHeading: "Why Most Published Research Findings Are False",
        fallback: "ioannidis",
      }),
    ).toBe("Why Most Published Research Findings Are False");
  });

  it("falls back to the filename rather than name a paper after its own section", () => {
    expect(chooseTitle({ firstPageHeading: "1 Introduction", fallback: "2607.24653v1" })).toBe(
      "2607.24653v1",
    );
    expect(chooseTitle({ firstPageHeading: "2. Preliminaries", fallback: "2504.13837v5" })).toBe(
      "2504.13837v5",
    );
  });

  it("collapses the whitespace of a title that was typeset across lines", () => {
    expect(
      chooseTitle({ metadata: "Nested Learning:\n  The Illusion of Deep\tLearning Architectures", fallback: "x" }),
    ).toBe("Nested Learning: The Illusion of Deep Learning Architectures");
  });
});

describe("usableMetadataTitle", () => {
  it("rejects what authoring tools leave behind", () => {
    for (const junk of [
      "",
      "   ",
      "untitled",
      "Untitled Document",
      "Microsoft Word - draft v3.doc",
      "paper.tex",
      "thesis.docx",
      "2607_24653v1",
      "arXiv:2607.24653v1",
      "abc",
    ]) {
      expect(usableMetadataTitle(junk), junk).toBeNull();
    }
  });

  it("keeps real titles, including the awkward ones", () => {
    for (const good of [
      "Kimi K3: Open Frontier Intelligence",
      "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
      "3D Gaussian Splatting for Real-Time Radiance Field Rendering",
      // One word, no digits — a filename would have had one or the other.
      "Backpropagation",
    ]) {
      expect(usableMetadataTitle(good), good).toBe(good);
    }
  });
});

describe("looksLikeSectionHeading", () => {
  it("catches numbered and bare section names", () => {
    for (const s of ["1 Introduction", "2. Preliminaries", "3.1) Results", "Abstract", "References", "Related Work"]) {
      expect(looksLikeSectionHeading(s), s).toBe(true);
    }
  });

  it("leaves titles that merely open with a number", () => {
    for (const s of [
      "3D Gaussian Splatting for Real-Time Radiance Field Rendering",
      "10 Lessons from Deploying Language Models in Production",
      "1000 Layers and Beyond: Scaling Depth",
    ]) {
      expect(looksLikeSectionHeading(s), s).toBe(false);
    }
  });
});
