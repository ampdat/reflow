# Reflow

**An Obsidian plugin that converts a PDF into clean, readable Markdown entirely on your device. Figures, tables, and math survive. Nothing uploads.**

Right-click a PDF in your vault → **Convert to Markdown**. A vision model runs
locally on your GPU and writes a Markdown package next to the source:

```
1706.03762v7.pdf
1706.03762v7/
  1706.03762v7.md     # frontmatter, headings, tables, $LaTeX$ math, figure links
  images/             # extracted figures
  meta.json           # engine, timings, warnings
```

No API key, no account, no page limit, and the document never leaves your
machine to be converted. A two-column paper becomes one reflowable column in
your own typography — which is the point of the name.

## Using it

- **Convert to Markdown** in a PDF's right-click menu, or the *Convert active
  PDF to Markdown* command.
- A progress dialog shows the page, live token count, elapsed time and estimate.
  Close it to keep reading — conversion carries on and moves to the status bar.
- Multiple conversions can run at the same time with separate progress in the
  status bar.
- Settings: output folder, page limit, per-page time limit, compute backend, and
  whether to convert on a background thread.

**Desktop only**, and a WebGPU-capable machine is strongly preferred: without one
the plugin falls back to the CPU, says so in red, and takes minutes per page.
The first conversion downloads about 1 GB of model weights from Hugging Face and
caches them — that and two pinned CDN assets are the only network use, itemised
in [plugin/README.md](./plugin/README.md#network-use).

**Note: Windows and Linux are untested.**

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

## Install

Not yet in the community directory. Until then, build it yourself:

```bash
cd plugin && npm install && npm run deploy
```

then enable **Reflow** in Settings → Community plugins. Full build and
development instructions: [plugin/README.md](./plugin/README.md).

## Architecture (target)

```
PDF ─┬─ fast tier: text-layer extract + layout heuristics (clean PDFs)
     └─ accurate tier: layout + table + OCR + formula models
              │
              ▼
   Structured document IR (JSON: typed blocks, provenance page/bbox,
   formula nodes carry LaTeX payloads)
              │
   ┌──────────┼──────────────┐
   ▼          ▼              ▼
 Markdown   EPUB          one-pager (later)
 + images/  (per-device
 (canonical) math: MathML
             or image)
```

- **Engine, target (primary):** a portable **TypeScript + ONNX** core in [`engine-js/`](./engine-js/) — a single compact VLM ([granite-docling-258M](https://huggingface.co/onnx-community/granite-docling-258M-ONNX), official ONNX export, Apache-2.0) running under [transformers.js](https://huggingface.co/blog/transformersjs-v4). Full page image → **DocTags** → Markdown, entirely in JS: no Python, no sidecar binary. The *same* core embeds in a Node CLI, an Obsidian desktop plugin, a browser extension, and eventually mobile — only `device`/`dtype` change. Rationale and route comparison: [docs/perf-and-portability.md](./docs/perf-and-portability.md).
- **Engine, bootstrap (reference oracle):** Python Docling (MIT) — the fast path that answered *is the quality there?* and froze the artifact contract + fixture suite. Retained as the **modular fallback** and a **numeric cross-check** for the VLM (it copies table cells from the PDF text layer; the VLM can invent them). Not on the shipping path.
- **Math policy:** LaTeX-first (`$...$`) — Obsidian renders it natively; images only as low-confidence fallback and for e-ink EPUB export.
- **Never silently wrong (VLM hedge):** VLM-emitted numeric table cells are reconciled against the pdf.js text layer; the fixture numeric-fidelity checks are the arbiter before any quantized build becomes default.