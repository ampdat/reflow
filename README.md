# Reflow

**Local, private PDF → clean Markdown. Figures, tables, and math survive. Nothing uploads.**

*(The repository is still named `pdf-to-md`; the shipping product — the Obsidian
plugin in [`plugin/`](./plugin) — is **Reflow**. The name says what it does to a
two-column paper, and it survives the move to EPUB and e-readers in M5.)*

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
4. **Never silently wrong.** No dropped figures without warning, no corrupted table numbers, no fake success on scanned inputs. Fail loudly — and fail loudly *where the reader will look*: a conversion that lost text says so in a banner at the top of the note and at the page it lost, not only in a sidecar JSON nobody opens.
5. **Measurable gates.** Fixtures + automated checks + a human "would I read this?" verdict, logged.
6. **Licensing clean.** MIT/Apache components for anything shipped commercially (Docling family ✅; Marker license-restricted — experiment only).

## Quality & tests

Quality is measured, not vibed. `fixtures/` holds a curated paper set — attention (math+tables+figures), BERT (true two-column, CC-BY), VAE (equation-dense), Ioannidis 2005 (medical, PLOS, CC-BY) — each with a `fixtures/expectations/<id>.json` of pass/fail checks in the style of [olmOCR-bench](https://huggingface.co/datasets/allenai/olmOCR-bench): title extraction, heading/figure/math counts, required content phrases, exact numeric table cells, forbidden artifacts. Every expected string is validated against the raw PDF text layer first, so ground truth is independent of the engine — the same suite prices any future engine change (quantization, VLM swap, JS port). Paywalled/confidential PDFs go in `fixtures/private/` (gitignored) and get auto-discovered smoke checks. Scale-up path: olmOCR-bench and [OmniDocBench](https://github.com/opendatalab/OmniDocBench) for large-scale eval, PubMed Central OA (CC-BY) for medical PDFs with free JATS-XML ground truth.

## Status

**M1–M3 done (portable engine at parity) → M4 (Obsidian plugin) in progress.** See [PLAN.md](./PLAN.md).

- ✅ **M1 (Python bootstrap, now frozen reference oracle):** the artifact contract + engine-independent fixture suite.
- ✅ **M2 (`engine-js/`, pure JS):** pdf.js + granite-docling-258M ONNX (transformers.js) + a hand-written DocTags→Markdown parser + a degenerate-generation guard. Offline unit-tested (20/20).
- ✅ **M3 (parity):** all 4 fixtures × TS-CPU vs Python oracle pass **all 7 ground-truth checks**; numeric table cells intact; equation-dense vae handled (35 vs 31 math blocks). fp32 everywhere — any f16 dtype garbles. **WebGPU and native CPU turn out to be within the same order** (an early "~6× CPU" figure did not reproduce; see PLAN.md), so WebGPU stays for the pure-JS distribution story rather than for speed.
- 🔨 **M4 (Obsidian plugin):** converts end-to-end on WebGPU in Obsidian — right-click a PDF, get a vault package. A progress dialog reports page, tokens, elapsed and ETA, cancels mid-page, and detaches to the status bar so you can keep reading. **The "conversion dies after a few pages" bug is fixed**: pdf.js schedules page rasterisation through `requestAnimationFrame`, which Chromium never fires while a window is hidden, so conversions parked forever the moment you switched away — nothing to do with WebGPU. **Inference now runs in a worker**, so the UI never stutters (main-thread lag p95 1.1 ms vs 17 ms, zero stalls over 100 ms vs 8) and the model's memory is reclaimed by terminating the thread after each conversion (1.0 GB vs 2.9 GB settled) — the feared unbounded memory growth turned out to be the Node/CPU path, not this one. The plugin is now **packaged for the community directory** as **Reflow**: the conversion worker and pdf.js's parsing worker are inlined into `main.js` (Obsidian installs only `main.js` + `manifest.json` + `styles.css`, so a fourth file silently downgraded every directory install to main-thread conversion), no executable code is fetched at runtime, and `eslint-plugin-obsidianmd` — the same check the directory runs on every published version — is error-clean. Remaining before Gate 4: first-run model download UX and weight caching.
- 📄 Full engineering log — CPU/WebGPU dtype findings, the LiteRT.js evaluation, the nougat spike sketch, per-target notes: [docs/perf-and-portability.md](./docs/perf-and-portability.md).

## License

**MIT** — see [LICENSE](./LICENSE). It matches Docling, the reference oracle this
was built against, and keeps every shipped component permissive: pdf.js and
transformers.js are Apache-2.0, onnxruntime-web is MIT, and granite-docling-258M
is Apache-2.0. Third-party models and libraries retain their own licenses.
