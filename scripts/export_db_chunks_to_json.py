import argparse
import json
import os
import re
from collections import defaultdict
from pathlib import Path

import infinity
import pymysql
from infinity.common import NetworkAddress


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", name or "")
    cleaned = cleaned.strip().strip(".")
    return cleaned or "unnamed_document"


def decode_hex_int_list(value: str) -> list[int]:
    if not value or not isinstance(value, str):
        return []
    return [int(x, 16) for x in value.split("_") if x]


def pages_from_position_int(value: str) -> list[int]:
    if not value or not isinstance(value, str):
        return []
    arr = [int(x, 16) for x in value.split("_") if x]
    return sorted({arr[i] for i in range(0, len(arr), 5) if i < len(arr)})


def infer_pages(row: dict) -> list[int]:
    pages = decode_hex_int_list(row.get("page_num_int"))
    if pages:
        return sorted(set(pages))
    return pages_from_position_int(row.get("position_int"))


def infer_primary_page(row: dict) -> int | None:
    pages = infer_pages(row)
    if pages:
        return min(pages)
    return None


def mysql_connect(args):
    return pymysql.connect(
        host=args.mysql_host,
        port=args.mysql_port,
        user=args.mysql_user,
        password=args.mysql_password,
        database=args.mysql_db,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )


def load_datasets(conn, dataset_id: str | None) -> list[dict]:
    with conn.cursor() as cur:
        if dataset_id:
            cur.execute(
                """
                SELECT id, tenant_id, name
                FROM knowledgebase
                WHERE id = %s
                """,
                (dataset_id,),
            )
        else:
            cur.execute(
                """
                SELECT id, tenant_id, name
                FROM knowledgebase
                WHERE status = '1'
                ORDER BY id
                """
            )
        return list(cur.fetchall())


def load_documents(conn, dataset_id: str) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, name, location
            FROM document
            WHERE kb_id = %s
            ORDER BY id
            """,
            (dataset_id,),
        )
        return list(cur.fetchall())


def get_infinity_table(conn, tenant_id: str, dataset_id: str):
    db = conn.get_database("default_db")
    table_name = f"ragflow_{tenant_id}_{dataset_id}"
    try:
        return db.get_table(table_name), table_name
    except Exception:
        return None, table_name


def load_all_chunks(table) -> dict[str, list[dict]]:
    df, _ = table.output(["*"]).to_df()
    rows_by_doc_id: dict[str, list[dict]] = defaultdict(list)
    for _, row in df.iterrows():
        record = {
            key: (None if hasattr(value, "item") and value is None else value)
            for key, value in row.to_dict().items()
        }
        doc_id = str(record.get("doc_id") or "").strip()
        if not doc_id:
            continue
        record["page_numbers"] = infer_pages(record)
        record["page_number"] = infer_primary_page(record)
        rows_by_doc_id[doc_id].append(record)
    return rows_by_doc_id


def choose_original_filename(doc: dict) -> str:
    if doc.get("name"):
        return str(doc["name"])
    if doc.get("location"):
        return os.path.basename(str(doc["location"]))
    return f"{doc['id']}.json"


def ensure_unique_path(base_dir: Path, filename: str, doc_id: str) -> Path:
    stem = sanitize_filename(Path(filename).stem)
    suffix = ".json"
    candidate = base_dir / f"{stem}{suffix}"
    if not candidate.exists():
        return candidate
    return base_dir / f"{stem}__{doc_id[:8]}{suffix}"


def export_dataset(
    mysql_conn,
    infinity_conn,
    dataset: dict,
    output_root: Path,
) -> tuple[int, int]:
    dataset_id = dataset["id"]
    tenant_id = dataset["tenant_id"]
    dataset_dir = output_root / dataset_id
    dataset_dir.mkdir(parents=True, exist_ok=True)

    docs = load_documents(mysql_conn, dataset_id)
    table, table_name = get_infinity_table(infinity_conn, tenant_id, dataset_id)
    if not table:
        print(f"[WARN] Infinity table not found: {table_name}")
        return len(docs), 0

    chunks_by_doc = load_all_chunks(table)
    exported = 0
    for doc in docs:
        original_file_name = choose_original_filename(doc)
        out_path = ensure_unique_path(dataset_dir, original_file_name, doc["id"])
        payload = {
            "dataset_id": dataset_id,
            "dataset_name": dataset.get("name"),
            "tenant_id": tenant_id,
            "document_id": doc["id"],
            "original_file_name": original_file_name,
            "chunk_count": len(chunks_by_doc.get(doc["id"], [])),
            "chunks": chunks_by_doc.get(doc["id"], []),
        }
        with out_path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        exported += 1

    return len(docs), exported


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-id", default=None)
    parser.add_argument(
        "--output-root",
        default="data/export_db/dataset",
        help="Output root directory",
    )
    parser.add_argument("--mysql-host", default="127.0.0.1")
    parser.add_argument("--mysql-port", type=int, default=5455)
    parser.add_argument("--mysql-user", default="root")
    parser.add_argument("--mysql-password", default="infini_rag_flow")
    parser.add_argument("--mysql-db", default="rag_flow")
    parser.add_argument("--infinity-host", default="127.0.0.1")
    parser.add_argument("--infinity-port", type=int, default=23817)
    return parser.parse_args()


def main():
    args = parse_args()
    output_root = Path(args.output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    mysql_conn = mysql_connect(args)
    inf_conn = infinity.connect(NetworkAddress(args.infinity_host, args.infinity_port))

    try:
        datasets = load_datasets(mysql_conn, args.dataset_id)
        if not datasets:
            print("No datasets found.")
            return

        total_docs = 0
        total_exported = 0
        for dataset in datasets:
            doc_count, exported = export_dataset(
                mysql_conn=mysql_conn,
                infinity_conn=inf_conn,
                dataset=dataset,
                output_root=output_root,
            )
            total_docs += doc_count
            total_exported += exported
            print(
                f"[OK] dataset={dataset['id']} docs={doc_count} exported={exported}"
            )

        print(
            f"[DONE] datasets={len(datasets)} docs={total_docs} exported={total_exported} output={output_root}"
        )
    finally:
        mysql_conn.close()


if __name__ == "__main__":
    main()
