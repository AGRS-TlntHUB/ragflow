#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data/ARLC_API"
ENV_FILE="$ROOT_DIR/.env"
BASE_URL="https://platform.agentic-challenge.ai/api/v1"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${ARLC_API_KEY:-}" ]]; then
  echo "Error: ARLC_API_KEY is not set. Add it to $ENV_FILE or export it." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

echo "Downloading questions (public_dataset.json)..."
curl -fSL "$BASE_URL/questions" \
  -H "X-API-Key: $ARLC_API_KEY" \
  -o "$DATA_DIR/public_dataset.json"

echo "Downloading documents archive..."
curl -fSL "$BASE_URL/documents" \
  -H "X-API-Key: $ARLC_API_KEY" \
  -o "$DATA_DIR/dataset_documents.zip"

echo "Extracting dataset_documents.zip..."
mkdir -p "$DATA_DIR/dataset_documents"
unzip -o "$DATA_DIR/dataset_documents.zip" -d "$DATA_DIR/dataset_documents"

echo "Done. Files are available in $DATA_DIR"
