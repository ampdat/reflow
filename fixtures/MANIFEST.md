# Fixtures

PDFs are fetched, not committed (`fixtures/*.pdf` is gitignored). Fetch with:

```bash
bash scripts/fetch_fixtures.sh
```

| ID | File | Source | Why |
|----|------|--------|-----|
| `attention` | attention.pdf | https://arxiv.org/pdf/1706.03762 | Math, tables, figures; the canonical paper fixture |
| `twocol` | (todo) | ACL-format two-column paper | Reading order under columns + floats |
| `tables` | (todo) | table-dense paper/report | Numeric fidelity check (no corrupted cells) |
| `mathheavy` | (todo) | equation-dense paper | LaTeX render rate |
| `scanned` | (todo) | image-only scan | Must fail loudly without --ocr |
