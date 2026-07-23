# Fixtures

PDFs are fetched, not committed (`fixtures/*.pdf` is gitignored). Fetch with:

```bash
bash scripts/fetch_fixtures.sh
```

Each fixture has a `fixtures/expectations/<id>.json` with pass/fail checks
(olmOCR-bench style). Expectation strings are validated against the raw PDF text
layer, so ground truth is independent of the converter.

| ID | File | Source | License | Why |
|----|------|--------|---------|-----|
| `attention` | attention.pdf | https://arxiv.org/pdf/1706.03762 | arXiv | Math, tables, figures; canonical paper fixture |
| `bert` | bert.pdf | https://aclanthology.org/N19-1423.pdf | CC-BY 4.0 | True two-column layout; reading order under columns + floats; result tables |
| `vae` | vae.pdf | https://arxiv.org/pdf/1312.6114 | arXiv | Equation-dense; LaTeX quality |
| `ioannidis` | ioannidis.pdf | https://journals.plos.org/plosmedicine/article/file?id=10.1371/journal.pmed.0020124&type=printable | CC-BY | Medical (PLOS Medicine 2005), two-column, tables/boxes |

## Private fixtures (paywalled / confidential)

Drop PDFs into `fixtures/private/` (gitignored). `tests/test_fixtures.py`
auto-discovers them and runs generic smoke checks (converts cleanly, has
headings/frontmatter, no font artifacts) — no ground truth required.

## Scaling up later

- **olmOCR-bench** (AI2, ODC-BY): 1,403 PDFs + 7,010 unit tests (text presence,
  reading order, tables, formulas) — adopt for large-scale eval of engine changes.
- **OmniDocBench** (OpenDataLab, CVPR 2025): full markdown ground truth with
  edit-distance/TEDS metrics — adopt when comparing engines (bootstrap vs ONNX).
- **PubMed Central Open Access (CC-BY subset)**: paired PDF + JATS XML full text —
  medical corpus where ground truth (sections, tables, captions) comes free.
- OCR/scanned fixtures: deferred (M1 excludes OCR).
