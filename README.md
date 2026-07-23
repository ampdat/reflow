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

- **Engine, bootstrap:** Python Docling (MIT) — fastest path to answering the only question that matters first: *is the quality there?*
- **Engine, target:** portable **ONNX** core running the same model family — one headless engine that later embeds in an Obsidian plugin, a Mac app, and eventually on-device mobile. Two candidate routes are being priced (see [docs/perf-and-portability.md](./docs/perf-and-portability.md)): a compact VLM (granite-docling-258M, official ONNX export, runs under transformers.js — pure-JS, no sidecar) vs. a Rust port of the modular pipeline.
- **Distribution ladder:** CLI (uv/Homebrew) → Obsidian plugin (thin JS over a native sidecar; desktop plugins can spawn processes) → Mac app → mobile.
- **Math policy:** LaTeX-first (`$...$`) — Obsidian renders it natively; images only as low-confidence fallback and for e-ink EPUB export.
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

Milestone 1 (PDF → vault-quality Markdown on Mac) in progress — see [PLAN.md](./PLAN.md):

- ✅ CLI (`uv run pdf2md convert paper.pdf`) → title-named vault-ready folder: `document.md` with Obsidian frontmatter properties + `images/` + `meta.json`
- ✅ Figures, Markdown tables, and MathJax-safe `$$LaTeX$$` (brace balancing, `\tag{}` equation numbers, `aligned` wrapping) verified on all four fixtures — 10/11 tests green
- ⚠ Perf: formula enrichment dominates on equation-dense papers (73 min for one 14-page paper — upstream forces the formula/table models onto CPU). Fix plan + portability research (Obsidian plugin → browser → mobile, all-JS via ONNX): [docs/perf-and-portability.md](./docs/perf-and-portability.md)

## License

TBD for application code. Third-party models and libraries retain their own licenses.
