# ARLC Quickstart for RAGFlow

## 1) Download ARLC data

```bash
cd /home/a1111/ragflow
bash scripts/download_ARLC_data_v0.sh
```

This downloads:

- `data/public_dataset.json`
- `data/dataset_documents.zip`
- extracted files under `data/dataset_documents/`

## 2) Build Docker and launch

Build the Docker image using the same tag configured in `docker/.env`:

```bash
cd /home/a1111/ragflow
bash scripts/dev-up.sh --build
```

Launch services and the Vite UI:

```bash
cd /home/a1111/ragflow
bash scripts/dev-up.sh -d
```

Rebuild after backend changes:

```bash
cd /home/a1111/ragflow
bash scripts/dev-down.sh
bash scripts/dev-up.sh --build -d
```

Stop services:

```bash
cd /home/a1111/ragflow
bash scripts/dev-down.sh
```

## 3) Launch RAGFlow UI

Open:

`http://localhost:{RAGFLOW_PORT}`

Default:

`http://localhost:9222`

If you change backend code, run `bash scripts/dev-up.sh --build -d` or use the rebuild sequence above.
