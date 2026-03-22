#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"

mkdir -p "$DATA_DIR"

echo "Downloading public_dataset.json..."
curl -L "https://platform.agentic-challenge.ai/files/data/public_dataset.json" \
  -o "$DATA_DIR/public_dataset.json"

echo "Downloading dataset_documents.zip..."
curl -L "https://platform.agentic-challenge.ai/files/data/dataset_documents.zip" \
  -o "$DATA_DIR/dataset_documents.zip"

echo "Extracting dataset_documents.zip..."
mkdir -p "$DATA_DIR/dataset_documents"
unzip -o "$DATA_DIR/dataset_documents.zip" -d "$DATA_DIR/dataset_documents"

echo "Done. Files are available in $DATA_DIR"
