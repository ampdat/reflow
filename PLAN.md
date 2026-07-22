# PLAN.md — Milestones (agent-executable)

Written for a coding agent (or human) to execute in order. **Do not skip gates.** Each milestone ends with runnable commands and a checklist; when a gate fails, fix that milestone — don't start the next.

Strategy in one paragraph: **prove reading quality first** (Markdown in Obsidian, bootstrap Python engine), **then** make delivery to e-readers effortless (EPUB → Books / Boox / Kindle), **then** package for humans (Obsidian plugin with native sidecar), **then** port the engine (ONNX) for portability — with on-device mobile as the unplanned end goal. Details and rationale in [README.md](./README.md).

## Environment

- Machine: MacBook Air M4, 32 GB (Apple Silicon).
- Python managed with **uv** (`uv sync`, `uv run pdf2md ...`). No bare pip/venv.
- Models: document every download (name, size, cache path) in `docs/models.md`. Offline must be real after cache warm.
- `out/` is gitignored scratch. Fixture PDFs are gitignored; `fixtures/MANIFEST.md` records sources + a fetch script.

## Artifact contract (freeze at M1)

```
out/<job>/
  document.md     # canonical: headings, MD/HTML tables, $LaTeX$ math, figure refs
  images/         # extracted figures, stable names
  meta.json       # source, engine id+version, page count, timings, warnings
  document.epub   # M2+
```

`meta.json.engine` labels the path honestly: `python-docling-bootstrap` now, `onnx-portable` later. Add fields rather than inventing parallel layouts.

---

# M1 — Papers read nicely in Obsidian ⭐ (current)

**Goal:** `pdf2md convert paper.pdf --out out/paper/` on the Mac produces a Markdown package that someone who read the PDF would rather read in Obsidian.

**Engine:** Python Docling with figure extraction and formula enrichment, labeled bootstrap. This is deliberately the fast path to the existential question — is the quality there? — before any portability work.

### Tasks

- [ ] uv project: `pyproject.toml`, `src/pdf2md/`, `pdf2md` entry point (`convert`, `version`).
- [ ] `convert` always writes `document.md` + `images/` + `meta.json` (contract above).
- [ ] Figures: extracted to `images/`, referenced inline at the right position with captions.
- [ ] Tables: Markdown tables (HTML fallback for row/col spans).
- [ ] Math: `$...$` / `$$...$$` LaTeX via Docling formula enrichment; flag to disable.
- [ ] Warn loudly on image-only pages (no silent empty success on scans).
- [ ] Fixtures: ~5 arXiv papers (fetch script + MANIFEST): clean single-column, dense two-column, math-heavy, table-heavy, scanned/image-only.
- [ ] `tests/`: automated checks per fixture — non-empty MD, heading hierarchy present, ≥1 image for figure fixtures, LaTeX render-parse rate, **no numeric table cell differs from source** on the table fixture.
- [ ] Human protocol → `out/obsidian_results.md`: open each result in an Obsidian vault, one-line verdict per fixture.

### Commands

```bash
uv sync
uv run pdf2md convert fixtures/attention.pdf --out out/attention
open out/attention/document.md   # or open the folder as an Obsidian vault
uv run pytest -q
```

### Gate 1 — "Rather read the Markdown"

| Check | Pass? |
|-------|-------|
| Contract files always written; engine + timings in `meta.json` | |
| Two-column fixture: reading order correct, no header/footer junk | |
| Headings → real `#` hierarchy (Obsidian outline = paper TOC) | |
| Figures present in `images/` and embedded with captions | |
| Tables faithful — zero corrupted numeric cells | |
| Math renders as LaTeX in Obsidian (rate recorded) | |
| Scanned fixture fails loudly (OCR may be deferred, silence may not) | |
| Human verdict: prefer the MD for ≥4/5 fixtures | |

**Stop if Gate 1 fails** — tune pipeline/models; nothing downstream matters without this.

---

# M2 — Easy local path to e-readers

**Goal:** one command from the validated Markdown package to a book on each reader, honest about each path.

- [ ] `--epub`: MD + images → EPUB (TOC from headings, `img { max-width:100% }`, math → MathML with image fallback for e-ink).
- [ ] Acceptance instrument: **Kindle Previewer 3** (opens EPUB locally, simulates Kindle rendering) + Apple Books.
- [ ] Delivery helpers: `--send books` (`open -a Books`, iCloud syncs to iPhone/iPad); `--send kindle` (Send to Kindle app/email — document the Amazon cloud hop); Boox/Kobo via USB/BooxDrop (document; fully local).
- [ ] Compare against Amazon Convert + Calibre on ≥2 real PDFs; note results.

**Gate 2:** reflow + figures + navigable TOC verified in Kindle Previewer and Books; clearly better than Amazon Convert on the comparison docs; delivery matrix documented.

---

# M3 — Effortless for humans (Obsidian plugin first)

**Goal:** the empty-quadrant product: right-click a PDF in Obsidian → note + figures + math land in the vault. No API keys, no server, nothing uploads.

- [ ] Thin JS plugin; conversion via native **sidecar** (desktop plugins can spawn processes) — sidecar is the same engine as the CLI.
- [ ] Model download on first run with disclosure + checksums (plugin review requirement).
- [ ] Vault craft: YAML frontmatter (title/authors/DOI/citekey), relative image links, optional provenance links to PDF pages (`[[paper.pdf#page=N]]`).

**Gate 3:** fresh Obsidian install → plugin → converted paper in vault in under 2 minutes, offline after model cache.

---

# M4 — Portable engine (ONNX)

**Goal:** replace the Python bootstrap with a portable ONNX core (Rust + `ort`, or equivalent) running the same model family — the engine that can later embed anywhere, including mobile.

- [ ] Assemble from parts (there is no ready-made "docling.rs": pdfium + layout ONNX + table + OCR + serialization). Time-boxed; go/no-go review if it drags.
- [ ] **Parity gate:** M1's automated checks + fixtures are the spec; the portable engine must match the bootstrap's quality scores.
- [ ] CoreML EP where it helps; assert providers in `meta.json` — never silent CPU fallback.

**Gate 4:** parity on fixtures, single-binary distribution, offline, licenses documented.

---

# Later — mobile / on-device (end goal, deliberately unplanned)

Boox Palma / Android on-device conversion and iOS share-sheet → convert → read. Unlocked only by Gates 1–4; will get its own plan (performance projection first) when the time comes. Nothing before that gates on mobile.

---

## Working rules for agents

1. uv for all Python; never bare pip. Keep `uv.lock` committed.
2. Preserve the artifact contract; extend `meta.json`, don't fork layouts.
3. Record timings (`wall_ms`, `pages`) in `meta.json` on every convert.
4. Document model downloads (size, URL, cache path) in `docs/models.md`.
5. Never silently wrong: warn on dropped figures, image-only pages, failed formula parses.
6. Marker stays experimental (license); Docling-family is the default.
7. Append to the Progress log when a gate passes or fails.

## Progress log

| Date | Milestone | Gate | Notes |
|------|-----------|------|-------|
| 2026-07-21 | — | — | Plan rewritten: Markdown-first (Obsidian quality → e-reader delivery → plugin → ONNX port → mobile later) |
| 2026-07-21 | M1 | — | Started: uv scaffold + Docling bootstrap |
