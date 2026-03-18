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

Build the Docker image:

```bash
cd /home/a1111/ragflow
docker build --platform linux/amd64 -f Dockerfile -t infiniflow/ragflow:nightly .
```

Launch services:

```bash
cd /home/a1111/ragflow
bash scripts/dev-up.sh -d
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

If you change backend code, rebuild the Docker image and relaunch services.
