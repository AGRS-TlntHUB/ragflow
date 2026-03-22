import requests
from pathlib import Path
import itertools
import sys
import time

API_KEY = "ragflow-wL6alE4MCp0hhZPHeJMydAobtA1gFtaI6NbSQivk5nk"
BASE_URL = "http://localhost:80/api/v1"
DATASET_ID = "1d2da8e6263a11f1a2f987d99f38d7dc"
FILES_DIR = Path("/home/a1111/ragflow/data/ARLC_API/dataset_documents")
BATCH_SIZE = 20
HEADERS = {"Authorization": f"Bearer {API_KEY}"}

def chunked(iterable, size):
    it = iter(iterable)
    while chunk := list(itertools.islice(it, size)):
        yield chunk

def wait_for_server():
    for i in range(30):
        try:
            r = requests.get(f"{BASE_URL}/datasets", headers=HEADERS, timeout=10)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(2)
    return False

def get_existing_names():
    names = set()
    page = 1
    while True:
        r = requests.get(
            f"{BASE_URL}/datasets/{DATASET_ID}/documents",
            headers=HEADERS,
            params={"page": page, "page_size": 100},
            timeout=30,
        )
        if r.status_code != 200:
            break
        data = r.json().get("data", {})
        docs = data.get("docs", [])
        if not docs:
            break
        for d in docs:
            names.add(d.get("name", ""))
        page += 1
    return names

def upload_batch(file_paths, retries=3):
    for attempt in range(retries):
        files = [("file", (p.name, open(p, "rb"))) for p in file_paths]
        try:
            resp = requests.post(
                f"{BASE_URL}/datasets/{DATASET_ID}/documents",
                headers=HEADERS,
                files=files,
                timeout=300,
            )
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 502 and attempt < retries - 1:
                print(f"502, waiting for server...", end=" ", flush=True)
                wait_for_server()
                continue
            return {"code": -1, "message": f"HTTP {resp.status_code}"}
        except requests.exceptions.ConnectionError:
            if attempt < retries - 1:
                print(f"conn error, retrying...", end=" ", flush=True)
                wait_for_server()
                continue
            return {"code": -1, "message": "Connection failed after retries"}
        finally:
            for _, (_, fh) in files:
                fh.close()

print("Waiting for server...", flush=True)
if not wait_for_server():
    print("Server not reachable")
    sys.exit(1)
print("Server ready.")

all_files = sorted(FILES_DIR.glob("*.pdf"))
print(f"Total files: {len(all_files)}")

existing_names = get_existing_names()
if existing_names:
    print(f"Already uploaded: {len(existing_names)}, skipping.")
    all_files = [f for f in all_files if f.name not in existing_names]
    print(f"Remaining: {len(all_files)}")

if not all_files:
    print("Nothing to upload.")
    sys.exit(0)

all_doc_ids = []
for i, batch in enumerate(chunked(all_files, BATCH_SIZE)):
    print(f"Batch {i+1} ({len(batch)} files)...", end=" ", flush=True)
    res = upload_batch(batch)
    if res.get("code") != 0:
        print(f"ERROR: {res.get('message')}")
        sys.exit(1)
    ids = [d["id"] for d in res.get("data", [])]
    all_doc_ids.extend(ids)
    print(f"OK ({len(all_doc_ids)} total)")

print(f"\nDone. Uploaded {len(all_doc_ids)} documents.")
