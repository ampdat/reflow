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
