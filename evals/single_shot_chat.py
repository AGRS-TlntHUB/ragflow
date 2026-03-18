#!/usr/bin/env python3
import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

try:
    from evals.utils import infer_ragflow_api_key, infer_ragflow_base_url
except ModuleNotFoundError:
    from utils import infer_ragflow_api_key, infer_ragflow_base_url


API_VERSION = "v1"


class ApiClient:
    def __init__(self, base_url: str, api_key: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        if api_key:
            self.session.headers.update({"Authorization": f"Bearer {api_key}"})

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        response = self.session.request(
            method=method.upper(),
            url=url,
            params=params,
            json=payload,
            timeout=self.timeout_seconds,
        )

        body: Any
        try:
            body = response.json()
        except ValueError:
            snippet = response.text[:500].strip()
            raise RuntimeError(
                f"{method.upper()} {path} returned non-JSON response "
                f"(http={response.status_code}): {snippet}"
            )

        if not isinstance(body, dict):
            raise RuntimeError(f"{method.upper()} {path} returned unexpected JSON payload: {type(body).__name__}")

        code = body.get("code")
        if response.status_code >= 400 or code != 0:
            message = body.get("message") or "request failed"
            raise RuntimeError(
                f"{method.upper()} {path} failed "
                f"(http={response.status_code}, code={code}): {message}"
            )

        return body.get("data")

    def get_chat(self, chat_id: str) -> dict[str, Any]:
        data = self._request(
            "GET",
            f"/api/{API_VERSION}/chats",
            params={"id": chat_id},
        )
        if not isinstance(data, list) or not data:
            raise RuntimeError(f"Chat not found: {chat_id}")
        chat = data[0]
        if not isinstance(chat, dict):
            raise RuntimeError(f"Unexpected chat payload for chat {chat_id}")
        return chat

    def create_dataset(self, name: str, kb_ids: list[str], description: str = "") -> str:
        data = self._request(
            "POST",
            f"/{API_VERSION}/evaluation/dataset/create",
            payload={"name": name, "description": description, "kb_ids": kb_ids},
        )
        dataset_id = (data or {}).get("dataset_id") if isinstance(data, dict) else None
        if not dataset_id:
            raise RuntimeError("Dataset creation succeeded but dataset_id is missing in response")
        return dataset_id

    def import_cases(self, dataset_id: str, cases: list[dict[str, Any]]) -> dict[str, int]:
        data = self._request(
            "POST",
            f"/{API_VERSION}/evaluation/dataset/{dataset_id}/case/import",
            payload={"cases": cases},
        )
        if not isinstance(data, dict):
            raise RuntimeError("Case import response has unexpected format")
        return {
            "success_count": int(data.get("success_count", 0)),
            "failure_count": int(data.get("failure_count", 0)),
            "total": int(data.get("total", 0)),
        }

    def start_run(self, dataset_id: str, chat_id: str, name: str | None = None) -> str:
        payload: dict[str, Any] = {"dataset_id": dataset_id, "dialog_id": chat_id}
        if name:
            payload["name"] = name
        data = self._request("POST", f"/{API_VERSION}/evaluation/run/start", payload=payload)
        run_id = (data or {}).get("run_id") if isinstance(data, dict) else None
        if not run_id:
            raise RuntimeError("Run start succeeded but run_id is missing in response")
        return run_id

    def get_run(self, run_id: str) -> dict[str, Any]:
        data = self._request("GET", f"/{API_VERSION}/evaluation/run/{run_id}")
        if not isinstance(data, dict):
            raise RuntimeError("Run details response has unexpected format")
        return data


def _load_questions(path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise RuntimeError(f"Questions dataset file not found: {path}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Questions dataset is not valid JSON: {exc}")

    if not isinstance(raw, list):
        raise RuntimeError("Questions dataset must be a JSON array")
    if not raw:
        raise RuntimeError("Questions dataset is empty")

    cases: list[dict[str, Any]] = []
    errors: list[str] = []
    for idx, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            errors.append(f"entry #{idx} must be an object")
            continue

        question = item.get("question")
        if not isinstance(question, str) or not question.strip():
            errors.append(f"entry #{idx} has missing/empty 'question'")
            continue

        metadata: dict[str, Any] = {}
        source_id = item.get("id")
        answer_type = item.get("answer_type")
        if source_id not in (None, ""):
            metadata["source_id"] = source_id
        if answer_type not in (None, ""):
            metadata["answer_type"] = answer_type

        case: dict[str, Any] = {"question": question.strip()}
        if metadata:
            case["metadata"] = metadata
        cases.append(case)

    if errors:
        sample = "; ".join(errors[:5])
        raise RuntimeError(f"Invalid questions dataset entries: {sample}")
    if not cases:
        raise RuntimeError("No valid questions found after parsing dataset")

    return cases


def _derive_kb_ids(chat: dict[str, Any], chat_id: str) -> list[str]:
    datasets = chat.get("datasets")
    if not isinstance(datasets, list):
        raise RuntimeError(f"Chat {chat_id} returned invalid datasets payload")
    kb_ids = [d.get("id") for d in datasets if isinstance(d, dict) and d.get("id")]
    if not kb_ids:
        raise RuntimeError(
            f"Chat {chat_id} has no attached datasets. "
            "Attach at least one dataset to the chat before running this script."
        )
    return kb_ids


def _poll_run(
    client: ApiClient,
    run_id: str,
    timeout_seconds: float,
    poll_interval_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while True:
        run_data = client.get_run(run_id)
        run = run_data.get("run", {})
        status = str(run.get("status", "")).upper()
        if status in {"COMPLETED", "FAILED"}:
            return run_data
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"Timed out waiting for run {run_id} to complete "
                f"after {timeout_seconds:.0f}s"
            )
        time.sleep(poll_interval_seconds)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run single-shot chat evaluation from a questions JSON file."
    )
    parser.add_argument("--chat-id", required=True, help="Chat ID to evaluate")
    parser.add_argument(
        "--questions-dataset-path",
        required=True,
        help="Path to JSON array of question objects",
    )
    parser.add_argument(
        "--print-resolved-config",
        action="store_true",
        help="Print inferred base URL and API version",
    )
    parser.add_argument(
        "--dataset-name",
        default="",
        help="Optional evaluation dataset name",
    )
    parser.add_argument(
        "--dataset-description",
        default="Created by evals/single_shot_chat.py",
        help="Optional evaluation dataset description",
    )
    parser.add_argument(
        "--run-name",
        default="",
        help="Optional evaluation run name",
    )
    parser.add_argument(
        "--poll-interval-seconds",
        type=float,
        default=2.0,
        help="Polling interval while waiting for run completion",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=600.0,
        help="Max wait time for run completion",
    )
    parser.add_argument(
        "--request-timeout-seconds",
        type=float,
        default=30.0,
        help="HTTP request timeout for each API call",
    )
    parser.add_argument(
        "--artifact-path",
        default="",
        help="Optional output path for full run JSON artifact",
    )
    parser.add_argument(
        "--no-artifact",
        action="store_true",
        help="Do not save local run JSON artifact",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    base_url = infer_ragflow_base_url()
    api_key = infer_ragflow_api_key()
    if args.print_resolved_config:
        print(f"base_url={base_url}")
        print(f"api_version={API_VERSION}")

    client = ApiClient(
        base_url=base_url,
        api_key=api_key,
        timeout_seconds=max(args.request_timeout_seconds, 1.0),
    )

    chat = client.get_chat(args.chat_id)
    kb_ids = _derive_kb_ids(chat, args.chat_id)
    cases = _load_questions(Path(args.questions_dataset_path))

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    dataset_name = args.dataset_name or f"single_shot_{args.chat_id[:8]}_{timestamp}"
    dataset_id = client.create_dataset(
        name=dataset_name,
        description=args.dataset_description,
        kb_ids=kb_ids,
    )

    import_stats = client.import_cases(dataset_id, cases)
    if import_stats["success_count"] == 0:
        raise RuntimeError(
            "Import failed for all cases "
            f"(total={import_stats['total']}, failure_count={import_stats['failure_count']})."
        )

    run_id = client.start_run(dataset_id=dataset_id, chat_id=args.chat_id, name=args.run_name or None)
    run_data = _poll_run(
        client=client,
        run_id=run_id,
        timeout_seconds=args.timeout_seconds,
        poll_interval_seconds=max(args.poll_interval_seconds, 0.5),
    )

    if not args.no_artifact:
        artifact_path = Path(args.artifact_path) if args.artifact_path else Path(f"run_result_{run_id}.json")
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_text(json.dumps(run_data, indent=2), encoding="utf-8")
        print(f"artifact_path={artifact_path}")

    run = run_data.get("run", {})
    status = run.get("status", "UNKNOWN")
    metrics_summary = run.get("metrics_summary") or {}
    result_count = len(run_data.get("results", []))

    print(f"dataset_id={dataset_id}")
    print(f"run_id={run_id}")
    print(f"status={status}")
    print(f"import_success={import_stats['success_count']}")
    print(f"import_failure={import_stats['failure_count']}")
    print(f"result_count={result_count}")
    print(f"metrics_summary={json.dumps(metrics_summary)}")

    if str(status).upper() == "FAILED":
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
