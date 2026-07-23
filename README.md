# pdf-to-md

**Local, private PDF → clean Markdown. Figures, tables, and math survive. Nothing uploads.**

Convert a PDF on your Mac and get a Markdown package your Obsidian vault reads beautifully — then, from that same clean core, an EPUB for your e-reader. Conversion is always local; delivery to each reader takes the smoothest path that reader allows.

---

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

The empty quadrant is the wedge: **Mathpix-class quality, fully local, unlimited, zero setup.** The moat is packaging craft (model management, sidecar binaries, vault integration, provenance links back to source pages) — exactly the part OSS engines and plugin authors haven't done.

## From Markdown to readers

The Markdown package is canonical; every reader is an export target. We are honest about each delivery path:

| Target | Path | Cloud? |
|--------|------|--------|
| **Obsidian / any vault** | copy `paper.md` + `images/` | Never |
| **Apple Books** (Mac, iPhone, iPad) | export EPUB → `open -a Books` → iCloud syncs to devices | Conversion local; Apple sync |
| **Boox / Kobo** (native EPUB readers) | export EPUB → USB / BooxDrop over LAN | Never — the fully-private e-reader path |
| **Kindle** | export EPUB → Send to Kindle (app/email) | Amazon converts in cloud — fewest clicks, not private |

Kindle's built-in "convert" and Boox's on-the-fly reflow are best-effort text re-extraction: fine on single-column, broken on two-column papers, floats, and math. We convert once, properly, with layout models — and hand every reader a real book.

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
- **Distribution ladder:** TS Node CLI (`pdf2md-js`) → Obsidian desktop plugin (pure JS: transformers.js + pdf.js, no sidecar) → browser extension → mobile.
- **Math policy:** LaTeX-first (`$...$`) — Obsidian renders it natively; images only as low-confidence fallback and for e-ink EPUB export.
- **Never silently wrong (VLM hedge):** VLM-emitted numeric table cells are reconciled against the pdf.js text layer; the fixture numeric-fidelity checks are the arbiter before any quantized build becomes default.
- **arXiv shortcut (later):** papers with arXiv IDs can skip PDF parsing entirely — fetch LaTeX source/HTML and normalize into the same IR, losslessly.

## End goal (not planned out)

On-device conversion on mobile and e-ink Android (a Boox Palma converting a paper by itself; iOS share-sheet → convert → read). The ONNX path keeps this door open — a Palma-class device (6 GB RAM) can run these models at seconds-per-page, acceptable for convert-then-read. This is deliberately **unplanned** until the desktop engine and quality bar are proven. See [PLAN.md](./PLAN.md).

## Principles

1. **Local-first, privacy by default.** Conversion never uploads. Delivery paths that touch a cloud say so, plainly.
2. **Quality before portability.** Prove "rather read the Markdown" with the bootstrap engine before investing in the portable one.
3. **Markdown package is the product; everything else is an export.** Freeze the artifact contract early.
4. **Never silently wrong.** No dropped figures without warning, no corrupted table numbers, no fake success on scanned inputs. Fail loudly.
5. **Measurable gates.** Fixtures + automated checks + a human "would I read this?" verdict, logged.
6. **Licensing clean.** MIT/Apache components for anything shipped commercially (Docling family ✅; Marker license-restricted — experiment only).

## Quality & tests

Quality is measured, not vibed. `fixtures/` holds a curated paper set — attention (math+tables+figures), BERT (true two-column, CC-BY), VAE (equation-dense), Ioannidis 2005 (medical, PLOS, CC-BY) — each with a `fixtures/expectations/<id>.json` of pass/fail checks in the style of [olmOCR-bench](https://huggingface.co/datasets/allenai/olmOCR-bench): title extraction, heading/figure/math counts, required content phrases, exact numeric table cells, forbidden artifacts. Every expected string is validated against the raw PDF text layer first, so ground truth is independent of the engine — the same suite prices any future engine change (quantization, VLM swap, JS port). Paywalled/confidential PDFs go in `fixtures/private/` (gitignored) and get auto-discovered smoke checks. Scale-up path: olmOCR-bench and [OmniDocBench](https://github.com/opendatalab/OmniDocBench) for large-scale eval, PubMed Central OA (CC-BY) for medical PDFs with free JATS-XML ground truth.

## Status

**M1 done → pivoted to the portable TypeScript + ONNX engine (M2, current).** See [PLAN.md](./PLAN.md).

- ✅ **M1 (Python bootstrap, now frozen reference oracle):** `pdf2md convert` → title-named vault folder (`document.md` + `images/` + `meta.json`); figures, Markdown tables, MathJax-safe `$$LaTeX$$` verified on all four fixtures. Its lasting output is the frozen artifact contract + the engine-independent fixture suite.
- 🔨 **M2 (`engine-js/`, pure JS):** pdf.js + granite-docling-258M ONNX (transformers.js) + a hand-written DocTags→Markdown parser. Scaffold landed and type-checks; the DocTags parser + MathJax repairs are **offline unit-tested (14/14 green)**. Remaining: first end-to-end model run (~190 MB q4f16 download) and fixture parity (M3).
- 📄 Perf finding that triggered the pivot (Python formula stage: 73 min on an equation-dense paper, forced to CPU upstream) and the full portability research: [docs/perf-and-portability.md](./docs/perf-and-portability.md).

## License

TBD for application code. Third-party models and libraries retain their own licenses.
