#!/usr/bin/env bash
# Fetch fixture PDFs (gitignored). See fixtures/MANIFEST.md.
set -euo pipefail
cd "$(dirname "$0")/.."

fetch() {
  local url="$1" dest="$2"
  if [ -f "$dest" ]; then
    echo "exists: $dest"
  else
    echo "fetching $url -> $dest"
    curl -fsSL "$url" -o "$dest"
  fi
}

fetch "https://arxiv.org/pdf/1706.03762" fixtures/attention.pdf
fetch "https://aclanthology.org/N19-1423.pdf" fixtures/bert.pdf
fetch "https://arxiv.org/pdf/1312.6114" fixtures/vae.pdf
fetch "https://journals.plos.org/plosmedicine/article/file?id=10.1371/journal.pmed.0020124&type=printable" fixtures/ioannidis.pdf
