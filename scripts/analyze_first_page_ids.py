import json
import re
from collections import defaultdict

import infinity
from infinity.common import NetworkAddress

TENANT = "dcbbd510208211f1baf59b17f42910d4"
KB = "40a87156208711f1baf59b17f42910d4"
TABLE = f"ragflow_{TENANT}_{KB}"

CASE_RE = re.compile(r"\b(?:CFI|ARB|CA|DEC|ENF|SCT|TCD)\s*\d{3}/\d{4}\b", re.I)
LAW_RE = re.compile(
    r"(?:DIFC\s+Law\s+No\.\s*\d+\s+of\s+\d{4}|Law\s+No\.\s*\d+\s+of\s+\d{4})",
    re.I,
)
ART_RE = re.compile(
    r"Article\s+\d+(?:\([a-z0-9]+\))?(?:\(\d+\))*(?:\([a-z]\))*",
    re.I,
)
SCHED_RE = re.compile(r"Schedule\s+\d+", re.I)


def decode_int_list(s):
    if not s or not isinstance(s, str):
        return []
    return [int(x, 16) for x in s.split("_") if x]


def pages_from_position_int(s):
    if not s or not isinstance(s, str):
        return []
    arr = [int(x, 16) for x in s.split("_") if x]
    return sorted({arr[i] for i in range(0, len(arr), 5) if i < len(arr)})


def chunk_pages(row):
    pn = decode_int_list(row.get("page_num_int") or "")
    if pn:
        return sorted(set(pn))
    return pages_from_position_int(row.get("position_int") or "")


def ok_doc(d):
    if d is None:
        return False
    return len(str(d).strip()) > 0


def flags_for(t):
    return {
        "case": bool(CASE_RE.search(t)),
        "law": bool(LAW_RE.search(t)),
        "article": bool(ART_RE.search(t)),
        "schedule": bool(SCHED_RE.search(t)),
    }


def main():
    conn = infinity.connect(NetworkAddress("infinity", 23817))
    db = conn.get_database("default_db")
    df, _ = db.get_table(TABLE).output(
        ["doc_id", "docnm", "content", "page_num_int", "position_int"]
    ).to_df()

    by_doc = defaultdict(list)
    for _, row in df.iterrows():
        if not ok_doc(row["doc_id"]):
            continue
        by_doc[row["doc_id"]].append(row.to_dict())

    per_doc = []
    for doc_id, chunks in sorted(by_doc.items()):
        p1_chunks = [c for c in chunks if 1 in chunk_pages(c)]
        strict_p1 = [
            c for c in chunks if chunk_pages(c) and max(chunk_pages(c)) == 1
        ]
        no_meta = [c for c in chunks if not chunk_pages(c)]
        text_touch = "\n".join((c.get("content") or "") for c in p1_chunks)
        text_strict = "\n".join((c.get("content") or "") for c in strict_p1)
        per_doc.append(
            {
                "doc_id": doc_id,
                "docnm": (chunks[0].get("docnm") or "")[:100],
                "chunks_total": len(chunks),
                "chunks_page1_touch": len(p1_chunks),
                "chunks_page1_only": len(strict_p1),
                "chunks_no_page_meta": len(no_meta),
                "touch_p1_flags": flags_for(text_touch),
                "strict_p1_flags": flags_for(text_strict),
            }
        )

    orphan_chunks = len(df) - sum(x["chunks_total"] for x in per_doc)

    summary = {
        "mysql_kb_id": KB,
        "infinity_table": TABLE,
        "note": "Chunk text/positions are in Infinity, not MySQL. MySQL has document metadata.",
        "documents_with_chunks": len(per_doc),
        "infinity_rows_ignored_empty_doc_id": orphan_chunks,
        "touch_page1_has_metadata": sum(1 for x in per_doc if x["chunks_page1_touch"] > 0),
        "no_chunk_marked_page1": sum(1 for x in per_doc if x["chunks_page1_touch"] == 0),
        "among_docs_with_page1_chunk_text_union": {
            "case_id_pattern": sum(1 for x in per_doc if x["touch_p1_flags"]["case"]),
            "law_id_pattern": sum(1 for x in per_doc if x["touch_p1_flags"]["law"]),
            "article_pattern": sum(1 for x in per_doc if x["touch_p1_flags"]["article"]),
            "schedule_pattern": sum(1 for x in per_doc if x["touch_p1_flags"]["schedule"]),
        },
        "among_chunks_strictly_page1_only_text_union": {
            "case_id_pattern": sum(1 for x in per_doc if x["strict_p1_flags"]["case"]),
            "law_id_pattern": sum(1 for x in per_doc if x["strict_p1_flags"]["law"]),
            "article_pattern": sum(1 for x in per_doc if x["strict_p1_flags"]["article"]),
            "schedule_pattern": sum(1 for x in per_doc if x["strict_p1_flags"]["schedule"]),
        },
    }

    no_p1 = [x for x in per_doc if x["chunks_page1_touch"] == 0]

    out = {"summary": summary, "docs_missing_page1_metadata": no_p1}
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
