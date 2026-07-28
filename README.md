# Reflow

**An Obsidian plugin that converts a PDF into clean, readable Markdown — and exports it to EPUB for e-readers — entirely on your device. Figures, tables, and math survive. Nothing uploads.**

Right-click a PDF in your vault → **Convert to Markdown**. A vision model runs
locally on your GPU and writes a Markdown package next to the source:

```
1706.03762v7.pdf
1706.03762v7/
  1706.03762v7.md     # frontmatter, headings, tables, $LaTeX$ math, figure links
  images/             # extracted figures, and a crop of each display equation
  meta.json           # engine, timings, warnings
```

Right-click any note → **Export to EPUB** for a `.epub` you can read on a Kindle
or other e-reader, with the figures embedded and the equations as images of the
original. Conversion can write one automatically too — see
[Formulas](#formulas) for why equations are handled that way.

No API key, no account, no page limit, and the document never leaves your
machine to be converted. A two-column paper becomes one reflowable column in
your own typography — which is the point of the name.

## Using it

- **Convert to Markdown** in a PDF's right-click menu, or the *Convert active
  PDF to Markdown* command.
- **Export to EPUB** in any note's right-click menu, or the *Export active note
  to EPUB* command. Takes well under a second — it reads the package, not the
  PDF, so it works on notes converted long ago.
- A progress dialog shows the page, live token count, elapsed time and estimate.
  Close it to keep reading — conversion carries on and moves to the status bar.
- Multiple conversions can run at the same time with separate progress in the
  status bar.
- Settings: output folder, page limit, per-page time limit, compute backend,
  whether to convert on a background thread, and whether to also write an EPUB
  on every conversion (off by default).

**Desktop only**, and a WebGPU-capable machine is strongly preferred: without one
the plugin falls back to the CPU, says so in red, and takes minutes per page.
The first conversion downloads about 1 GB of model weights from Hugging Face and
caches them — that and two pinned CDN assets are the only network use, itemised
in [plugin/README.md](./plugin/README.md#network-use).

**Note: Windows and Linux are untested.**

## Formulas

Equations take two routes into the Markdown, and only one is structured.
**Display equations** come from a tagged `<formula>` block and are wrapped in
`$$…$$`; **inline maths** is never tagged — the model writes `$…$` inside a
paragraph's text, so `h$_{t}$` just passes through. In Obsidian both simply
render: Obsidian bundles MathJax and draws `$$…$$` and `$…$` natively. The
plugin ships no maths renderer.

**The EPUB cannot rely on that.** Kindle renders neither LaTeX nor MathML, and in
testing it accepted inline SVG and then silently discarded it — a book that
validates cleanly with the equations missing. So conversion crops each display
equation straight out of the rendered page, exactly as it already does for
figures, and the EPUB uses those crops. Nothing about the Markdown changes.

That turned out to be both cheaper and more faithful than re-rendering the LaTeX.
Cheaper: bundling MathJax would have added ~662 KB gzipped, roughly 45% to the
plugin, and the crops came out 4.5× smaller than rendered equation images.
More faithful: **the crop is the page**, whereas a renderer can only be as good
as the model's transcription — which is sometimes truncated.

The cost of that choice lands on notes with **no** crops — hand-written ones, or
packages converted before this existed. They still export, and sub/superscripts
still render, but a display equation has nothing to draw: it becomes a labelled
*"Formula could not be rendered"* block that keeps the LaTeX source, so the
reader knows it is a limit of the export rather than a broken document.

**Truncated formulas are detected and offered back to you.** The repair pass
balances braces so MathJax renders *something*, which means a formula the model
cut off short renders cleanly and looks correct — equation (1) of the Transformer
paper loses its closing paren, its `V` and its equation number, silently. When
the conversion spots one, the note gets a collapsed callout under the equation:

> [!warning]- This formula may be incomplete — show the original from the PDF

Click it and the original from the PDF appears. The count also joins the
conversion-warnings banner at the top of the note. Full detail in
[plugin/README.md](./plugin/README.md#formulas); the measurements are in
[docs/spike-epub.md](./docs/spike-epub.md).

## Thesis

Markdown is the native format AI consumes and generates, and it is quietly becoming the best *reading* format humans own: reflowable, themeable, searchable, yours. Meanwhile the science of PDF → structured text is largely solved in open source (Docling, Marker, MinerU, Granite-Docling) — but it is packaged for developers, not humans.

**The product: a converter good enough that someone who read the PDF would rather read the Markdown.**

Two benefits fall out:

1. **Normalization.** Every paper — regardless of journal, era, or layout idiosyncrasy — becomes the same clean, reflowable reading surface in your typography and theme. Headings become a real outline/TOC. Figures sit inline. Math renders (Obsidian renders LaTeX natively).
2. **Ownership + privacy.** The document never leaves your machine to be converted. Confidential docs (legal, medical, unpublished work) stay confidential.

## The open niche

PDF → Markdown is crowded — but every existing option gives up one of *effortless*, *complete* (figures + LaTeX + tables), or *local*:

| Option | Effortless | Complete | Local |
|--------|-----------|----------|-------|
| Mathpix ($4.99/mo) | ✅ | ✅ | ❌ cloud, 10 free pages/mo |
| Obsidian AI plugins (Marker/Mistral/GPT) | ~ (API keys) | ✅ | ❌ upload, or self-host a Python server |
| Markitdown / heuristic tools | ✅ | ❌ naive extraction | ✅ |
| OSS engines (Docling, Marker CLI) | ❌ Python env, flags | ✅ | ✅ |
| **This project** | **✅** | **✅** | **✅** |


## Architecture (target)

```
PDF ─┬─ fast tier: text-layer extract + layout heuristics (clean PDFs)
     └─ accurate tier: layout + table + OCR + formula models
              │
              ▼
   Structured document IR (JSON: typed blocks, provenance page/bbox,
   formula nodes carry LaTeX payloads)
              │
              ▼
 ┌───────────────────────────────────────────────────┐
 │ Markdown package — canonical, and the only thing  │      any other
 │ downstream ever reads                             │ ◀──  Obsidian note
 │   <stem>.md   headings, tables, $LaTeX$ math      │      (no package:
 │   images/     figures + a crop of each equation   │       math stays
 │   meta.json   which crop belongs to which formula │       LaTeX source)
 └───────────────────────────────────────────────────┘
              │
   ┌──────────┴───────────┐
   ▼                      ▼
 EPUB                one-pager (later)
 (equations as the
  page crops)
```

The IR is where the provenance lives, but nothing downstream sees it: conversion
materializes the bboxes into `images/` + `meta.json`, and the exporter reads only
the package. `engine-js/src/epub.ts` has no imports at all — hand it a note's text
and a way to read its images and it produces a book, which is why **Export to
EPUB** works on any note in the vault, not just a converted one.

- **Engine, target (primary):** a portable **TypeScript + ONNX** core in [`engine-js/`](./engine-js/) — a single compact VLM ([granite-docling-258M](https://huggingface.co/onnx-community/granite-docling-258M-ONNX), official ONNX export, Apache-2.0) running under [transformers.js](https://huggingface.co/blog/transformersjs-v4). Full page image → **DocTags** → Markdown, entirely in JS: no Python, no sidecar binary. The *same* core embeds in a Node CLI, an Obsidian desktop plugin, a browser extension, and eventually mobile — only `device`/`dtype` change. Rationale and route comparison: [docs/perf-and-portability.md](./docs/perf-and-portability.md).
- **Engine, bootstrap (reference oracle):** Python Docling (MIT) — the fast path that answered *is the quality there?* and froze the artifact contract + fixture suite. Retained as the **modular fallback** and a **numeric cross-check** for the VLM (it copies table cells from the PDF text layer; the VLM can invent them). Not on the shipping path.
- **Math policy:** LaTeX-first (`$...$`) in the Markdown — Obsidian renders it natively, so the plugin ships no maths renderer. The EPUB cannot rely on that (Kindle drops MathML and silently discards SVG), so display equations export as the crop taken from the page during conversion and sub/superscripts become `<sup>`/`<sub>`. A note with no crops still exports, but its display equations do not render: each becomes a labelled *"Formula could not be rendered"* block keeping the LaTeX source. See [Formulas](#formulas).
- **Never silently wrong (VLM hedge):** VLM-emitted numeric table cells are reconciled against the pdf.js text layer; the fixture numeric-fidelity checks are the arbiter before any quantized build becomes default.