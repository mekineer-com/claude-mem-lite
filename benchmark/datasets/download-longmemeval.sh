#!/usr/bin/env bash
# Fetch the LongMemEval dataset used by benchmark/longmemeval.mjs.
#
# The dataset is ~300 MB and is NOT committed to this repo (see .gitignore).
# Source: LongMemEval (Wu et al.) — https://github.com/xiaowu0162/LongMemEval
# Cleaned JSON mirror on Hugging Face (default below). If the URL 404s, the
# dataset card may have moved the file — confirm the filename there and override:
#   LME_URL=<direct-json-url> bash benchmark/datasets/download-longmemeval.sh
#
# Requires either `huggingface-cli` (preferred, handles auth/resume) or `curl`.
set -euo pipefail

DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${DEST_DIR}/longmemeval_s_cleaned.json"
HF_REPO="xiaowu0162/longmemeval-cleaned"
HF_FILE="longmemeval_s_cleaned.json"
LME_URL="${LME_URL:-https://huggingface.co/datasets/${HF_REPO}/resolve/main/${HF_FILE}}"

if [ -f "${OUT}" ]; then
  echo "Already present: ${OUT} ($(du -h "${OUT}" | cut -f1))"
  echo "Delete it to re-download."
  exit 0
fi

echo "Downloading LongMemEval → ${OUT}"
if command -v huggingface-cli >/dev/null 2>&1; then
  huggingface-cli download "${HF_REPO}" "${HF_FILE}" \
    --repo-type dataset --local-dir "${DEST_DIR}"
else
  echo "huggingface-cli not found; falling back to curl from ${LME_URL}"
  curl -fL --retry 3 -o "${OUT}.partial" "${LME_URL}"
  mv "${OUT}.partial" "${OUT}"
fi

# Sanity check: the real file is hundreds of MB of JSON, not an HTML error page.
BYTES="$(wc -c < "${OUT}")"
if [ "${BYTES}" -lt 1000000 ]; then
  echo "WARNING: ${OUT} is only ${BYTES} bytes — likely an error page, not the dataset." >&2
  echo "Check the dataset card and re-run with LME_URL=<correct-url>." >&2
  exit 1
fi

echo "Done: ${OUT} ($(du -h "${OUT}" | cut -f1))"
echo "Run:  node benchmark/longmemeval.mjs ${OUT}"
