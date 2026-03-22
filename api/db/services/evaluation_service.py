#
#  Copyright 2025 The InfiniFlow Authors. All Rights Reserved.
#
#  Licensed under the Apache License, Version 2.0 (the "License");
#  you may not use this file except in compliance with the License.
#  You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#  Unless required by applicable law or agreed to in writing, software
#  distributed under the License is distributed on an "AS IS" BASIS,
#  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#  See the License for the specific language governing permissions and
#  limitations under the License.
#

"""
RAG Evaluation Service

Provides functionality for evaluating RAG system performance including:
- Dataset management
- Test case management
- Evaluation execution
- Metrics computation
- Configuration recommendations
"""

import asyncio
import fnmatch
import io
import json
import logging
import os
import queue
import re
import subprocess
import threading
import traceback
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime
from timeit import default_timer as timer
import requests

from api.db.db_models import (
    EvaluationDataset,
    EvaluationCase,
    EvaluationRun,
    EvaluationResult,
    EvaluationTemplate,
    EvaluationTypeScript,
    SystemSettings,
)
from api.db.services.common_service import CommonService
from api.db.services.dialog_service import DialogService
from common.misc_utils import get_uuid
from common.time_utils import current_timestamp
from common.constants import StatusEnum


class EvaluationService(CommonService):
    """Service for managing RAG evaluations"""

    model = EvaluationDataset
    SINGLE_SHOT_CHAT_EVAL_TYPE = "Single-Shot Chat"
    SINGLE_SHOT_CHAT_SCRIPT_PATH = "ragflow/evals/single_shot_chat.py"
    MAX_CONCURRENT_EVALUATIONS = 50
    MAX_CONCURRENT_JUDGE_CALLS = 20
    CASE_STATUS_OK = "OK"
    CASE_STATUS_MISSING_TELEMETRY = "MISSING_TELEMETRY"
    CASE_STATUS_FAILED = "FAILED"
    RUN_STATUS_MISSING_TELEMETRY = "MISSING_TELEMETRY"
    SUBMISSION_API_KEY_SETTING_NAME = "evaluation.submission_api_key"
    ARTIFACTS_DIR = Path("/tmp/ragflow_eval_artifacts")
    REPO_ROOT = Path(__file__).resolve().parents[3]

    @classmethod
    def _load_env_file(cls) -> None:
        env_path = cls.REPO_ROOT / ".env"
        if not env_path.is_file():
            return
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip("'\"")
            if key and key not in os.environ:
                os.environ[key] = value

    @classmethod
    def _get_submission_api_key(cls) -> str:
        key = os.getenv("ARLC_API_KEY", "").strip()
        if key:
            return key
        cls._load_env_file()
        return os.getenv("ARLC_API_KEY", "").strip()

    @classmethod
    def has_submission_api_key(cls) -> bool:
        return bool(cls._get_submission_api_key())

    @classmethod
    def set_submission_api_key(cls, api_key: str) -> Tuple[bool, str]:
        return False, "API key is managed via ARLC_API_KEY in .env"

    @classmethod
    def _ensure_eval_type_script_mapping(cls, tenant_id: str, user_id: str) -> None:
        mapping = EvaluationTypeScript.get_or_none(
            (EvaluationTypeScript.tenant_id == tenant_id)
            & (EvaluationTypeScript.eval_type == cls.SINGLE_SHOT_CHAT_EVAL_TYPE)
            & (EvaluationTypeScript.status == StatusEnum.VALID.value)
        )
        if mapping:
            return

        timestamp = current_timestamp()
        EvaluationTypeScript.create(
            id=get_uuid(),
            tenant_id=tenant_id,
            eval_type=cls.SINGLE_SHOT_CHAT_EVAL_TYPE,
            script_path=cls.SINGLE_SHOT_CHAT_SCRIPT_PATH,
            created_by=user_id,
            create_time=timestamp,
            update_time=timestamp,
            status=StatusEnum.VALID.value,
        )

    @classmethod
    def list_eval_type_scripts(cls, tenant_id: str, user_id: str) -> List[Dict[str, Any]]:
        try:
            cls._ensure_eval_type_script_mapping(tenant_id, user_id)
            rows = (
                EvaluationTypeScript.select()
                .where(
                    (EvaluationTypeScript.tenant_id == tenant_id)
                    & (EvaluationTypeScript.status == StatusEnum.VALID.value)
                )
                .order_by(EvaluationTypeScript.create_time.asc())
            )
            return [row.to_dict() for row in rows]
        except Exception as e:
            logging.error(f"Error listing evaluation type scripts: {e}")
            return []

    @classmethod
    def create_eval_template(
        cls,
        *,
        tenant_id: str,
        user_id: str,
        eval_type: str,
        dataset_id: str,
        dataset_path: str,
    ) -> Tuple[bool, str]:
        try:
            cls._ensure_eval_type_script_mapping(tenant_id, user_id)
            mapping = EvaluationTypeScript.get_or_none(
                (EvaluationTypeScript.tenant_id == tenant_id)
                & (EvaluationTypeScript.eval_type == eval_type)
                & (EvaluationTypeScript.status == StatusEnum.VALID.value)
            )
            if not mapping:
                return False, f"Unsupported eval type: {eval_type}"

            path_obj = Path(dataset_path).expanduser()
            if not path_obj.exists() or not path_obj.is_file():
                return False, f"Dataset file does not exist: {dataset_path}"

            raw_content = path_obj.read_text(encoding="utf-8")
            parsed = json.loads(raw_content)
            if not isinstance(parsed, list):
                return False, "Dataset file must be a JSON array"

            timestamp = current_timestamp()
            template_id = get_uuid()
            EvaluationTemplate.create(
                id=template_id,
                tenant_id=tenant_id,
                eval_type=eval_type,
                dataset_id=dataset_id,
                dataset_path=dataset_path,
                dataset_content=raw_content,
                created_by=user_id,
                create_time=timestamp,
                update_time=timestamp,
                status=StatusEnum.VALID.value,
            )
            return True, template_id
        except Exception as e:
            logging.error(f"Error creating evaluation template: {e}")
            return False, str(e)

    @classmethod
    def list_eval_templates(cls, tenant_id: str, user_id: str) -> List[Dict[str, Any]]:
        try:
            cls._ensure_eval_type_script_mapping(tenant_id, user_id)
            script_map = {
                item["eval_type"]: item["script_path"]
                for item in cls.list_eval_type_scripts(tenant_id, user_id)
            }
            rows = (
                EvaluationTemplate.select()
                .where(
                    (EvaluationTemplate.tenant_id == tenant_id)
                    & (EvaluationTemplate.status == StatusEnum.VALID.value)
                )
                .order_by(EvaluationTemplate.create_time.asc())
            )
            templates = [row.to_dict() for row in rows]
            for template in templates:
                template["script_path"] = script_map.get(template.get("eval_type"), "")
            return templates
        except Exception as e:
            logging.error(f"Error listing evaluation templates: {e}")
            return []

    @classmethod
    def delete_eval_template(cls, template_id: str, tenant_id: str) -> bool:
        try:
            return (
                EvaluationTemplate.update(
                    status=StatusEnum.INVALID.value,
                    update_time=current_timestamp(),
                )
                .where(
                    (EvaluationTemplate.id == template_id)
                    & (EvaluationTemplate.tenant_id == tenant_id)
                )
                .execute()
                > 0
            )
        except Exception as e:
            logging.error(f"Error deleting evaluation template {template_id}: {e}")
            return False

    @classmethod
    def _safe_int(cls, value: Any) -> Optional[int]:
        if isinstance(value, bool) or value is None:
            return None
        if isinstance(value, (int, float)):
            return int(value)
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return None
            try:
                return int(float(raw))
            except Exception:
                return None
        return None

    @classmethod
    def _extract_page_numbers_from_chunk(cls, chunk: Dict[str, Any]) -> List[int]:
        pages: List[int] = []
        keys = [
            "page_number",
            "page_numbers",
            "page_num",
            "page_num_int",
            "page",
            "page_id",
            "positions",
        ]
        for key in keys:
            value = chunk.get(key)
            if value is None:
                continue
            candidates: List[Any]
            if isinstance(value, list):
                candidates = value
            else:
                candidates = [value]
            for candidate in candidates:
                if isinstance(candidate, dict):
                    for dict_key in ("page_number", "page_num", "page", "page_num_int"):
                        page_no = cls._safe_int(candidate.get(dict_key))
                        if page_no and page_no > 0:
                            pages.append(page_no)
                elif isinstance(candidate, (list, tuple)) and len(candidate) >= 1:
                    page_no = cls._safe_int(candidate[0])
                    if page_no and page_no > 0:
                        pages.append(page_no)
                else:
                    page_no = cls._safe_int(candidate)
                    if page_no and page_no > 0:
                        pages.append(page_no)
        return sorted(set(pages))

    @classmethod
    def _resolve_doc_id(cls, chunk: Dict[str, Any]) -> Optional[str]:
        raw = (
            chunk.get("docnm_kwd")
            or chunk.get("doc_name")
            or chunk.get("document_name")
            or chunk.get("doc_id")
            or chunk.get("document_id")
        )
        if not isinstance(raw, str) or not raw.strip():
            return None
        raw = raw.strip()
        if raw.lower().endswith(".pdf"):
            raw = raw[:-4]
        return raw

    @classmethod
    def _normalize_retrieved_chunk_pages(cls, retrieved_chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        pages_by_doc: Dict[str, set] = {}
        for chunk in retrieved_chunks or []:
            if not isinstance(chunk, dict):
                continue
            doc_id = cls._resolve_doc_id(chunk)
            if not doc_id:
                continue
            page_numbers = cls._extract_page_numbers_from_chunk(chunk)
            if not page_numbers:
                continue
            if doc_id not in pages_by_doc:
                pages_by_doc[doc_id] = set()
            pages_by_doc[doc_id].update(page_numbers)

        normalized = []
        for doc_id, pages in sorted(pages_by_doc.items(), key=lambda item: item[0]):
            normalized.append(
                {
                    "doc_id": doc_id,
                    "page_numbers": sorted(pages),
                }
            )
        return normalized

    @classmethod
    def _build_telemetry(
        cls,
        raw_answer: Dict[str, Any],
        retrieved_chunks: List[Dict[str, Any]],
        execution_time_ms: int,
        model_name_hint: Optional[str] = None,
        question: Optional[str] = None,
        generated_answer: Optional[str] = None,
        is_parallel: bool = False,
    ) -> Dict[str, Any]:
        try:
            from rag.nlp import num_tokens_from_string
        except Exception:
            num_tokens_from_string = lambda s: max(1, len(s) // 4)

        raw_answer = raw_answer or {}
        provided_telemetry = raw_answer.get("telemetry") if isinstance(raw_answer, dict) else {}
        provided_timing = provided_telemetry.get("timing", {}) if isinstance(provided_telemetry, dict) else {}
        provided_retrieval = provided_telemetry.get("retrieval", {}) if isinstance(provided_telemetry, dict) else {}
        provided_usage = provided_telemetry.get("usage", {}) if isinstance(provided_telemetry, dict) else {}
        usage_obj = raw_answer.get("usage") or raw_answer.get("token_usage") or {}

        upstream_ttft = (
            cls._safe_int(provided_timing.get("ttft_ms"))
            or cls._safe_int(raw_answer.get("ttft_ms"))
            or cls._safe_int(raw_answer.get("time_to_first_token_ms"))
        )
        tpot_ms = (
            cls._safe_int(provided_timing.get("tpot_ms"))
            or cls._safe_int(raw_answer.get("tpot_ms"))
            or cls._safe_int(raw_answer.get("time_per_output_token_ms"))
        )
        total_time_ms = (
            cls._safe_int(provided_timing.get("total_time_ms"))
            or cls._safe_int(raw_answer.get("total_time_ms"))
            or cls._safe_int(raw_answer.get("elapsed_ms"))
            or execution_time_ms
        )

        if upstream_ttft:
            ttft_ms = upstream_ttft
        elif is_parallel:
            ttft_ms = None
        else:
            ttft_ms = execution_time_ms

        retrieved_chunk_pages = provided_retrieval.get("retrieved_chunk_pages")
        if not isinstance(retrieved_chunk_pages, list):
            retrieved_chunk_pages = cls._normalize_retrieved_chunk_pages(retrieved_chunks)

        input_tokens = (
            cls._safe_int(provided_usage.get("input_tokens") if isinstance(provided_usage, dict) else None)
            or cls._safe_int(usage_obj.get("input_tokens"))
            or cls._safe_int(usage_obj.get("prompt_tokens"))
        )
        output_tokens = (
            cls._safe_int(provided_usage.get("output_tokens") if isinstance(provided_usage, dict) else None)
            or cls._safe_int(usage_obj.get("output_tokens"))
            or cls._safe_int(usage_obj.get("completion_tokens"))
        )
        provider_total = cls._safe_int(usage_obj.get("total_tokens"))

        if output_tokens is None and generated_answer:
            output_tokens = num_tokens_from_string(generated_answer)
        if input_tokens is None and provider_total and output_tokens:
            input_tokens = max(0, provider_total - output_tokens)
        if input_tokens is None and question:
            chunk_text = " ".join(
                c.get("content_with_weight", "") or c.get("content_ltks", "") or ""
                for c in (retrieved_chunks or [])
                if isinstance(c, dict)
            )
            input_tokens = num_tokens_from_string(question + chunk_text)

        if tpot_ms is None and output_tokens and output_tokens > 1 and total_time_ms and ttft_ms:
            generation_ms = total_time_ms - ttft_ms
            if generation_ms > 0:
                tpot_ms = int(generation_ms / (output_tokens - 1))
        if not is_parallel:
            tpot_ms = tpot_ms or 0

        telemetry = {
            "timing": {
                "ttft_ms": ttft_ms,
                "tpot_ms": tpot_ms,
                "total_time_ms": total_time_ms,
                "execution_time_ms": execution_time_ms,
            },
            "retrieval": {
                "retrieved_chunk_pages": retrieved_chunk_pages,
            },
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
            "model_name": raw_answer.get("model_name")
            or raw_answer.get("model")
            or raw_answer.get("model_id")
            or (provided_telemetry.get("model_name") if isinstance(provided_telemetry, dict) else None)
            or model_name_hint,
            "is_parallel": is_parallel,
        }
        return telemetry

    @classmethod
    def _validate_telemetry(cls, telemetry: Dict[str, Any]) -> bool:
        if not isinstance(telemetry, dict):
            return False
        timing = telemetry.get("timing")
        retrieval = telemetry.get("retrieval")
        usage = telemetry.get("usage")
        model_name = telemetry.get("model_name")
        if not isinstance(timing, dict) or not isinstance(retrieval, dict) or not isinstance(usage, dict):
            return False
        if not isinstance(model_name, str) or not model_name.strip():
            return False

        for key in ("ttft_ms", "tpot_ms", "total_time_ms"):
            value = cls._safe_int(timing.get(key))
            if value is None or value < 0:
                return False

        input_tokens = cls._safe_int(usage.get("input_tokens"))
        output_tokens = cls._safe_int(usage.get("output_tokens"))
        if input_tokens is None or input_tokens < 0 or output_tokens is None or output_tokens < 0:
            return False

        retrieved_chunk_pages = retrieval.get("retrieved_chunk_pages")
        if not isinstance(retrieved_chunk_pages, list) or not retrieved_chunk_pages:
            return False
        for item in retrieved_chunk_pages:
            if not isinstance(item, dict):
                return False
            doc_id = item.get("doc_id")
            page_numbers = item.get("page_numbers")
            if not isinstance(doc_id, str) or not doc_id.strip():
                return False
            if not isinstance(page_numbers, list) or not page_numbers:
                return False
            for page_no in page_numbers:
                normalized_page_no = cls._safe_int(page_no)
                if normalized_page_no is None or normalized_page_no <= 0:
                    return False
        return True

    @classmethod
    def _derive_case_status(cls, telemetry: Optional[Dict[str, Any]], failed: bool = False) -> str:
        if failed:
            return cls.CASE_STATUS_FAILED
        if cls._validate_telemetry(telemetry or {}):
            return cls.CASE_STATUS_OK
        return cls.CASE_STATUS_MISSING_TELEMETRY

    @classmethod
    def _derive_run_status(cls, results: List[Dict[str, Any]]) -> str:
        if not results:
            return cls.CASE_STATUS_FAILED
        failed_count = sum(1 for result in results if result.get("case_status") == cls.CASE_STATUS_FAILED)
        missing_count = sum(
            1 for result in results if result.get("case_status") == cls.CASE_STATUS_MISSING_TELEMETRY
        )
        completed_count = len(results) - failed_count
        if failed_count > 0 and failed_count >= completed_count:
            return cls.CASE_STATUS_FAILED
        if missing_count > 0:
            return cls.RUN_STATUS_MISSING_TELEMETRY
        return "COMPLETED"

    @classmethod
    def _hydrate_result_with_status(cls, raw_result: Dict[str, Any]) -> Dict[str, Any]:
        result = dict(raw_result)
        telemetry = result.get("telemetry")
        if not isinstance(telemetry, dict):
            telemetry = {
                "timing": {
                    "ttft_ms": cls._safe_int((result.get("execution_time") or 0) * 1000),
                    "tpot_ms": None,
                    "total_time_ms": cls._safe_int((result.get("execution_time") or 0) * 1000),
                },
                "retrieval": {
                    "retrieved_chunk_pages": cls._normalize_retrieved_chunk_pages(
                        result.get("retrieved_chunks") or []
                    ),
                },
                "usage": {
                    "input_tokens": cls._safe_int((result.get("token_usage") or {}).get("input_tokens"))
                    or cls._safe_int((result.get("token_usage") or {}).get("prompt_tokens")),
                    "output_tokens": cls._safe_int((result.get("token_usage") or {}).get("output_tokens"))
                    or cls._safe_int((result.get("token_usage") or {}).get("completion_tokens")),
                },
                "model_name": None,
            }
            result["telemetry"] = telemetry

        case_status = result.get("case_status")
        if not isinstance(case_status, str) or not case_status:
            case_status = cls._derive_case_status(telemetry)
            result["case_status"] = case_status
        return result

    @classmethod
    def _artifact_paths(cls, run_id: str) -> Tuple[Path, Path]:
        cls.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
        return (
            cls.ARTIFACTS_DIR / f"submission_{run_id}.json",
            cls.ARTIFACTS_DIR / "code_archive.zip",
        )

    # ==================== Dataset Management ====================

    @classmethod
    def create_dataset(cls, name: str, description: str, kb_ids: List[str],
                      tenant_id: str, user_id: str) -> Tuple[bool, str]:
        """
        Create a new evaluation dataset.

        Args:
            name: Dataset name
            description: Dataset description
            kb_ids: List of knowledge base IDs to evaluate against
            tenant_id: Tenant ID
            user_id: User ID who creates the dataset

        Returns:
            (success, dataset_id or error_message)
        """
        try:
            timestamp= current_timestamp()
            dataset_id = get_uuid()
            dataset = {
                "id": dataset_id,
                "tenant_id": tenant_id,
                "name": name,
                "description": description,
                "kb_ids": kb_ids,
                "created_by": user_id,
                "create_time": timestamp,
                "update_time": timestamp,
                "status": StatusEnum.VALID.value
            }

            if not EvaluationDataset.create(**dataset):
                return False, "Failed to create dataset"

            return True, dataset_id
        except Exception as e:
            logging.error(f"Error creating evaluation dataset: {e}")
            return False, str(e)

    @classmethod
    def get_dataset(cls, dataset_id: str) -> Optional[Dict[str, Any]]:
        """Get dataset by ID"""
        try:
            dataset = EvaluationDataset.get_by_id(dataset_id)
            if dataset:
                return dataset.to_dict()
            return None
        except Exception as e:
            logging.error(f"Error getting dataset {dataset_id}: {e}")
            return None

    @classmethod
    def list_datasets(cls, tenant_id: str, user_id: str,
                     page: int = 1, page_size: int = 20) -> Dict[str, Any]:
        """List datasets for a tenant"""
        try:
            query = EvaluationDataset.select().where(
                (EvaluationDataset.tenant_id == tenant_id) &
                (EvaluationDataset.status == StatusEnum.VALID.value)
            ).order_by(EvaluationDataset.create_time.desc())

            total = query.count()
            datasets = query.paginate(page, page_size)

            return {
                "total": total,
                "datasets": [d.to_dict() for d in datasets]
            }
        except Exception as e:
            logging.error(f"Error listing datasets: {e}")
            return {"total": 0, "datasets": []}

    @classmethod
    def update_dataset(cls, dataset_id: str, **kwargs) -> bool:
        """Update dataset"""
        try:
            kwargs["update_time"] = current_timestamp()
            return EvaluationDataset.update(**kwargs).where(
                EvaluationDataset.id == dataset_id
            ).execute() > 0
        except Exception as e:
            logging.error(f"Error updating dataset {dataset_id}: {e}")
            return False

    @classmethod
    def delete_dataset(cls, dataset_id: str) -> bool:
        """Soft delete dataset"""
        try:
            return EvaluationDataset.update(
                status=StatusEnum.INVALID.value,
                update_time=current_timestamp()
            ).where(EvaluationDataset.id == dataset_id).execute() > 0
        except Exception as e:
            logging.error(f"Error deleting dataset {dataset_id}: {e}")
            return False

    # ==================== Test Case Management ====================

    @classmethod
    def add_test_case(cls, dataset_id: str, question: str,
                     reference_answer: Optional[str] = None,
                     relevant_doc_ids: Optional[List[str]] = None,
                     relevant_chunk_ids: Optional[List[str]] = None,
                     metadata: Optional[Dict[str, Any]] = None) -> Tuple[bool, str]:
        """
        Add a test case to a dataset.

        Args:
            dataset_id: Dataset ID
            question: Test question
            reference_answer: Optional ground truth answer
            relevant_doc_ids: Optional list of relevant document IDs
            relevant_chunk_ids: Optional list of relevant chunk IDs
            metadata: Optional additional metadata

        Returns:
            (success, case_id or error_message)
        """
        try:
            case_id = get_uuid()
            case = {
                "id": case_id,
                "dataset_id": dataset_id,
                "question": question,
                "reference_answer": reference_answer,
                "relevant_doc_ids": relevant_doc_ids,
                "relevant_chunk_ids": relevant_chunk_ids,
                "metadata": metadata,
                "create_time": current_timestamp()
            }

            if not EvaluationCase.create(**case):
                return False, "Failed to create test case"

            return True, case_id
        except Exception as e:
            logging.error(f"Error adding test case: {e}")
            return False, str(e)

    @classmethod
    def get_test_cases(cls, dataset_id: str) -> List[Dict[str, Any]]:
        """Get all test cases for a dataset"""
        try:
            cases = EvaluationCase.select().where(
                EvaluationCase.dataset_id == dataset_id
            ).order_by(EvaluationCase.create_time)

            return [c.to_dict() for c in cases]
        except Exception as e:
            logging.error(f"Error getting test cases for dataset {dataset_id}: {e}")
            return []

    @classmethod
    def delete_test_case(cls, case_id: str) -> bool:
        """Delete a test case"""
        try:
            return EvaluationCase.delete().where(
                EvaluationCase.id == case_id
            ).execute() > 0
        except Exception as e:
            logging.error(f"Error deleting test case {case_id}: {e}")
            return False

    @classmethod
    def import_test_cases(cls, dataset_id: str, cases: List[Dict[str, Any]]) -> Tuple[int, int]:
        """
        Bulk import test cases from a list.

        Args:
            dataset_id: Dataset ID
            cases: List of test case dictionaries

        Returns:
            (success_count, failure_count)
        """
        success_count = 0
        failure_count = 0
        case_instances = []
        
        if not cases:
            return success_count, failure_count
        
        cur_timestamp = current_timestamp()

        try:
            for case_data in cases:
                case_id = get_uuid()
                case_info = {
                    "id": case_id,
                    "dataset_id": dataset_id,
                    "question": case_data.get("question", ""),
                    "reference_answer": case_data.get("reference_answer"),
                    "relevant_doc_ids": case_data.get("relevant_doc_ids"),
                    "relevant_chunk_ids": case_data.get("relevant_chunk_ids"),
                    "metadata": case_data.get("metadata"),
                    "create_time": cur_timestamp
                }

                case_instances.append(EvaluationCase(**case_info))
            EvaluationCase.bulk_create(case_instances, batch_size=300)
            success_count = len(case_instances)
            failure_count = 0

        except Exception as e:
            logging.error(f"Error bulk importing test cases: {str(e)}")
            failure_count = len(cases)
            success_count = 0

        return success_count, failure_count

    # ==================== Evaluation Execution ====================

    @classmethod
    def start_evaluation(
        cls,
        dataset_id: str,
        dialog_id: str,
        user_id: str,
        name: Optional[str] = None,
        parallel: bool = True,
        max_workers: Optional[int] = None,
    ) -> Tuple[bool, str]:
        try:
            success, dialog = DialogService.get_by_id(dialog_id)
            if not success:
                return False, "Dialog not found"

            run_id = get_uuid()
            if not name:
                name = f"Evaluation Run {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"

            run = {
                "id": run_id,
                "dataset_id": dataset_id,
                "dialog_id": dialog_id,
                "name": name,
                "config_snapshot": dialog.to_dict(),
                "metrics_summary": None,
                "progress": 0.0,
                "status": "RUNNING",
                "created_by": user_id,
                "create_time": current_timestamp(),
                "complete_time": None
            }

            if not EvaluationRun.create(**run):
                return False, "Failed to create evaluation run"

            threading.Thread(
                target=cls._execute_evaluation,
                args=(run_id, dataset_id, dialog),
                kwargs={"parallel": parallel, "max_workers": max_workers},
                daemon=True,
            ).start()

            return True, run_id
        except Exception as e:
            logging.error(f"Error starting evaluation: {e}")
            return False, str(e)

    @classmethod
    def _execute_evaluation(
        cls,
        run_id: str,
        dataset_id: str,
        dialog: Any,
        parallel: bool = True,
        max_workers: Optional[int] = None,
    ):
        effective_max_workers = 1 if not parallel else (max_workers or cls.MAX_CONCURRENT_EVALUATIONS)
        is_parallel = effective_max_workers > 1

        log_buf = io.StringIO()
        log_handler = logging.StreamHandler(log_buf)
        log_handler.setLevel(logging.DEBUG)
        log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root_logger = logging.getLogger()
        root_logger.addHandler(log_handler)
        try:
            test_cases = cls.get_test_cases(dataset_id)

            if not test_cases:
                log_buf.write("No test cases found for dataset\n")
                EvaluationRun.update(
                    status="FAILED",
                    run_logs=log_buf.getvalue(),
                    complete_time=current_timestamp()
                ).where(EvaluationRun.id == run_id).execute()
                return

            total = len(test_cases)
            results = []
            done = 0
            progress_lock = threading.Lock()
            run_wall_start = timer()
            with ThreadPoolExecutor(max_workers=effective_max_workers) as executor:
                futures = {
                    executor.submit(cls._evaluate_single_case, run_id, case, dialog, is_parallel): case
                    for case in test_cases
                }
                for future in as_completed(futures):
                    try:
                        result = future.result()
                    except Exception as exc:
                        case = futures[future]
                        logging.error(f"Unhandled error evaluating case {case.get('id')}: {exc}")
                        result = None
                    if result:
                        results.append(result)
                    with progress_lock:
                        done += 1
                        EvaluationRun.update(
                            progress=done / total,
                            progress_msg=f"{done}/{total}",
                        ).where(EvaluationRun.id == run_id).execute()
            run_wall_seconds = timer() - run_wall_start

            metrics_summary = cls._compute_summary_metrics(results, run_wall_seconds=run_wall_seconds)
            run_status = cls._derive_run_status(results)

            EvaluationRun.update(
                status=run_status,
                progress=1.0,
                metrics_summary=metrics_summary,
                run_logs=log_buf.getvalue(),
                complete_time=current_timestamp()
            ).where(EvaluationRun.id == run_id).execute()

        except Exception as e:
            logging.error(f"Error executing evaluation {run_id}: {e}")
            log_buf.write(f"\n--- EXCEPTION ---\n{traceback.format_exc()}\n")
            EvaluationRun.update(
                status="FAILED",
                run_logs=log_buf.getvalue(),
                complete_time=current_timestamp()
            ).where(EvaluationRun.id == run_id).execute()
        finally:
            root_logger.removeHandler(log_handler)

    @classmethod
    def _evaluate_single_case(cls, run_id: str, case: Dict[str, Any],
                             dialog: Any, is_parallel: bool = False) -> Optional[Dict[str, Any]]:
        try:
            # Prepare messages
            messages = [{"role": "user", "content": case["question"]}]

            # Execute RAG pipeline
            start_time = timer()
            answer = ""
            retrieved_chunks = []
            raw_answer = {}


            def _sync_from_async_gen(async_gen):
                result_queue: queue.Queue = queue.Queue()

                def runner():
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)

                    async def consume():
                        try:
                            async for item in async_gen:
                                result_queue.put(item)
                        except Exception as e:
                            result_queue.put(e)
                        finally:
                            result_queue.put(StopIteration)

                    loop.run_until_complete(consume())
                    loop.close()

                threading.Thread(target=runner, daemon=True).start()

                while True:
                    item = result_queue.get()
                    if item is StopIteration:
                        break
                    if isinstance(item, Exception):
                        raise item
                    yield item


            def chat(dialog, messages, stream=True, **kwargs):
                from api.db.services.dialog_service import async_chat

                return _sync_from_async_gen(async_chat(dialog, messages, stream=stream, **kwargs))

            for ans in chat(dialog, messages, stream=False):
                if isinstance(ans, dict):
                    raw_answer = ans
                    answer = ans.get("answer", "")
                    retrieved_chunks = ans.get("reference", {}).get("chunks", [])
                    break

            execution_time = timer() - start_time
            execution_time_ms = int(execution_time * 1000)
            if isinstance(dialog, dict):
                model_name_hint = dialog.get("llm_id") or dialog.get("model") or dialog.get("model_name")
            else:
                model_name_hint = getattr(dialog, "llm_id", None) or getattr(dialog, "model", None)
            telemetry = cls._build_telemetry(
                raw_answer,
                retrieved_chunks,
                execution_time_ms,
                model_name_hint=model_name_hint,
                question=case["question"],
                generated_answer=answer,
                is_parallel=is_parallel,
            )
            case_status = cls._derive_case_status(telemetry=telemetry)

            # Compute metrics
            metrics = cls._compute_metrics(
                question=case["question"],
                generated_answer=answer,
                reference_answer=case.get("reference_answer"),
                retrieved_chunks=retrieved_chunks,
                relevant_chunk_ids=case.get("relevant_chunk_ids"),
                dialog=dialog
            )

            # Save result
            result_id = get_uuid()
            result = {
                "id": result_id,
                "run_id": run_id,
                "case_id": case["id"],
                "generated_answer": answer,
                "retrieved_chunks": retrieved_chunks,
                "metrics": metrics,
                "execution_time": execution_time,
                "token_usage": raw_answer.get("usage") or raw_answer.get("token_usage"),
                "telemetry": telemetry,
                "case_status": case_status,
                "create_time": current_timestamp()
            }

            EvaluationResult.create(**result)

            return result
        except Exception as e:
            logging.error(f"Error evaluating case {case.get('id')}: {e}")
            failed_result = {
                "id": get_uuid(),
                "run_id": run_id,
                "case_id": case["id"],
                "generated_answer": "",
                "retrieved_chunks": [],
                "metrics": {},
                "execution_time": 0.0,
                "token_usage": None,
                "telemetry": None,
                "case_status": cls.CASE_STATUS_FAILED,
                "create_time": current_timestamp(),
            }
            EvaluationResult.create(**failed_result)
            return failed_result

    @classmethod
    def _compute_metrics(cls, question: str, generated_answer: str,
                        reference_answer: Optional[str],
                        retrieved_chunks: List[Dict[str, Any]],
                        relevant_chunk_ids: Optional[List[str]],
                        dialog: Any) -> Dict[str, float]:
        """
        Compute evaluation metrics for a single test case.

        Returns:
            Dictionary of metric names to values
        """
        metrics = {}

        # Retrieval metrics (if ground truth chunks provided)
        if relevant_chunk_ids:
            retrieved_ids = [c.get("chunk_id") for c in retrieved_chunks]
            metrics.update(cls._compute_retrieval_metrics(retrieved_ids, relevant_chunk_ids))

        # Generation metrics
        if generated_answer:
            # Basic metrics
            metrics["answer_length"] = len(generated_answer)
            metrics["has_answer"] = 1.0 if generated_answer.strip() else 0.0

            # TODO: Implement advanced metrics using LLM-as-judge
            # - Faithfulness (hallucination detection)
            # - Answer relevance
            # - Context relevance
            # - Semantic similarity (if reference answer provided)

        return metrics

    @classmethod
    def _compute_retrieval_metrics(cls, retrieved_ids: List[str],
                                   relevant_ids: List[str]) -> Dict[str, float]:
        """
        Compute retrieval metrics.

        Args:
            retrieved_ids: List of retrieved chunk IDs
            relevant_ids: List of relevant chunk IDs (ground truth)

        Returns:
            Dictionary of retrieval metrics
        """
        if not relevant_ids:
            return {}

        retrieved_set = set(retrieved_ids)
        relevant_set = set(relevant_ids)

        # Precision: proportion of retrieved that are relevant
        precision = len(retrieved_set & relevant_set) / len(retrieved_set) if retrieved_set else 0.0

        # Recall: proportion of relevant that were retrieved
        recall = len(retrieved_set & relevant_set) / len(relevant_set) if relevant_set else 0.0

        # F1 score
        f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

        # Hit rate: whether any relevant chunk was retrieved
        hit_rate = 1.0 if (retrieved_set & relevant_set) else 0.0

        # MRR (Mean Reciprocal Rank): position of first relevant chunk
        mrr = 0.0
        for i, chunk_id in enumerate(retrieved_ids, 1):
            if chunk_id in relevant_set:
                mrr = 1.0 / i
                break

        return {
            "precision": precision,
            "recall": recall,
            "f1_score": f1,
            "hit_rate": hit_rate,
            "mrr": mrr
        }

    @classmethod
    def _compute_summary_metrics(
        cls,
        results: List[Dict[str, Any]],
        run_wall_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        if not results:
            return {}

        hydrated_results = [cls._hydrate_result_with_status(result) for result in results]

        metric_sums: Dict[str, float] = {}
        metric_counts: Dict[str, int] = {}

        ttft_vals: List[int] = []
        tpot_vals: List[int] = []
        total_time_vals: List[int] = []
        input_token_vals: List[int] = []
        output_token_vals: List[int] = []

        for result in hydrated_results:
            if result.get("case_status") == cls.CASE_STATUS_FAILED:
                continue
            metrics = result.get("metrics", {})
            for key, value in metrics.items():
                if isinstance(value, (int, float)):
                    metric_sums[key] = metric_sums.get(key, 0) + value
                    metric_counts[key] = metric_counts.get(key, 0) + 1

            telemetry = result.get("telemetry")
            if isinstance(telemetry, dict):
                timing = telemetry.get("timing") or {}
                usage = telemetry.get("usage") or {}
                v = cls._safe_int(timing.get("ttft_ms"))
                if v is not None and v > 0:
                    ttft_vals.append(v)
                v = cls._safe_int(timing.get("tpot_ms"))
                if v is not None and v > 0:
                    tpot_vals.append(v)
                v = cls._safe_int(timing.get("total_time_ms"))
                if v is not None and v > 0:
                    total_time_vals.append(v)
                v = cls._safe_int(usage.get("input_tokens"))
                if v is not None and v > 0:
                    input_token_vals.append(v)
                v = cls._safe_int(usage.get("output_tokens"))
                if v is not None and v > 0:
                    output_token_vals.append(v)

        failed_count = sum(1 for result in hydrated_results if result.get("case_status") == cls.CASE_STATUS_FAILED)
        missing_telemetry_count = sum(
            1
            for result in hydrated_results
            if result.get("case_status") == cls.CASE_STATUS_MISSING_TELEMETRY
        )
        ok_count = sum(1 for result in hydrated_results if result.get("case_status") == cls.CASE_STATUS_OK)
        completed_count = len(hydrated_results) - failed_count

        summary: Dict[str, Any] = {
            "total_cases": len(hydrated_results),
            "completed_cases": completed_count,
            "ok_cases": ok_count,
            "missing_telemetry_cases": missing_telemetry_count,
            "failed_cases": failed_count,
            "telemetry_complete_rate": (ok_count / completed_count) if completed_count else 0.0,
        }

        exec_time_vals = [
            r.get("execution_time", 0)
            for r in hydrated_results
            if r.get("case_status") != cls.CASE_STATUS_FAILED
        ]
        if exec_time_vals:
            summary["sum_execution_time_s"] = round(sum(exec_time_vals), 3)

        if run_wall_seconds is not None:
            summary["run_duration_s"] = round(run_wall_seconds, 3)

        if ttft_vals:
            summary["avg_ttft_ms"] = int(sum(ttft_vals) / len(ttft_vals))
        if tpot_vals:
            summary["avg_tpot_ms"] = int(sum(tpot_vals) / len(tpot_vals))
        if total_time_vals:
            summary["avg_total_time_ms"] = int(sum(total_time_vals) / len(total_time_vals))
        if input_token_vals:
            summary["avg_input_tokens"] = int(sum(input_token_vals) / len(input_token_vals))
        if output_token_vals:
            summary["avg_output_tokens"] = int(sum(output_token_vals) / len(output_token_vals))

        for key in metric_sums:
            summary[f"avg_{key}"] = metric_sums[key] / metric_counts[key]

        return summary

    # ==================== Rerun Failed ====================

    @classmethod
    def rerun_failed(
        cls,
        source_run_id: str,
        user_id: str,
        parallel: bool = True,
        max_workers: Optional[int] = None,
    ) -> Tuple[bool, str]:
        try:
            source_run = EvaluationRun.get_or_none(EvaluationRun.id == source_run_id)
            if not source_run:
                return False, "Source evaluation run not found"
            if source_run.status in ("RUNNING", "PENDING"):
                return False, "Source run is still in progress"

            source_results = list(
                EvaluationResult.select().where(EvaluationResult.run_id == source_run_id)
            )
            if not source_results:
                return False, "Source run has no results"

            hydrated = [cls._hydrate_result_with_status(r.to_dict()) for r in source_results]
            rerun_case_ids = {
                r["case_id"]
                for r in hydrated
                if r.get("case_status") in (cls.CASE_STATUS_FAILED, cls.CASE_STATUS_MISSING_TELEMETRY)
            }
            if not rerun_case_ids:
                return False, "No failed or missing-telemetry cases to rerun"

            success, dialog = DialogService.get_by_id(source_run.dialog_id)
            if not success:
                return False, "Dialog not found for source run"

            run_id = get_uuid()
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            name = (source_run.name or "") + f" (rerun {now})"

            EvaluationRun.create(
                id=run_id,
                dataset_id=source_run.dataset_id,
                dialog_id=source_run.dialog_id,
                name=name,
                config_snapshot=dialog.to_dict(),
                metrics_summary=None,
                progress=0.0,
                status="RUNNING",
                created_by=user_id,
                create_time=current_timestamp(),
                complete_time=None,
            )

            ok_results = [r for r in hydrated if r["case_id"] not in rerun_case_ids]
            for r in ok_results:
                EvaluationResult.create(
                    id=get_uuid(),
                    run_id=run_id,
                    case_id=r["case_id"],
                    generated_answer=r.get("generated_answer", ""),
                    retrieved_chunks=r.get("retrieved_chunks", []),
                    metrics=r.get("metrics", {}),
                    execution_time=r.get("execution_time", 0.0),
                    token_usage=r.get("token_usage"),
                    telemetry=r.get("telemetry"),
                    case_status=r.get("case_status", cls.CASE_STATUS_OK),
                    create_time=current_timestamp(),
                )

            threading.Thread(
                target=cls._execute_rerun,
                args=(run_id, source_run.dataset_id, dialog, rerun_case_ids, len(ok_results)),
                kwargs={"parallel": parallel, "max_workers": max_workers},
                daemon=True,
            ).start()

            return True, run_id
        except Exception as e:
            logging.error(f"Error rerunning failed cases: {e}")
            return False, str(e)

    @classmethod
    def _execute_rerun(
        cls,
        run_id: str,
        dataset_id: str,
        dialog: Any,
        rerun_case_ids: set,
        pre_copied_count: int,
        parallel: bool = True,
        max_workers: Optional[int] = None,
    ):
        effective_max_workers = 1 if not parallel else (max_workers or cls.MAX_CONCURRENT_EVALUATIONS)
        is_parallel = effective_max_workers > 1

        log_buf = io.StringIO()
        log_handler = logging.StreamHandler(log_buf)
        log_handler.setLevel(logging.DEBUG)
        log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root_logger = logging.getLogger()
        root_logger.addHandler(log_handler)
        try:
            test_cases = [c for c in cls.get_test_cases(dataset_id) if c["id"] in rerun_case_ids]
            total = pre_copied_count + len(test_cases)
            results = []
            done = pre_copied_count
            progress_lock = threading.Lock()
            run_wall_start = timer()
            with ThreadPoolExecutor(max_workers=effective_max_workers) as executor:
                futures = {
                    executor.submit(cls._evaluate_single_case, run_id, case, dialog, is_parallel): case
                    for case in test_cases
                }
                for future in as_completed(futures):
                    try:
                        result = future.result()
                    except Exception as exc:
                        case = futures[future]
                        logging.error(f"Unhandled error re-evaluating case {case.get('id')}: {exc}")
                        result = None
                    if result:
                        results.append(result)
                    with progress_lock:
                        done += 1
                        EvaluationRun.update(
                            progress=done / total,
                            progress_msg=f"{done}/{total}",
                        ).where(EvaluationRun.id == run_id).execute()
            run_wall_seconds = timer() - run_wall_start

            all_result_rows = list(
                EvaluationResult.select().where(EvaluationResult.run_id == run_id)
            )
            all_hydrated = [cls._hydrate_result_with_status(r.to_dict()) for r in all_result_rows]
            metrics_summary = cls._compute_summary_metrics(all_hydrated, run_wall_seconds=run_wall_seconds)
            run_status = cls._derive_run_status(all_hydrated)

            EvaluationRun.update(
                status=run_status,
                progress=1.0,
                metrics_summary=metrics_summary,
                run_logs=log_buf.getvalue(),
                complete_time=current_timestamp(),
            ).where(EvaluationRun.id == run_id).execute()
        except Exception as e:
            logging.error(f"Error executing rerun {run_id}: {e}")
            log_buf.write(f"\n--- EXCEPTION ---\n{traceback.format_exc()}\n")
            EvaluationRun.update(
                status="FAILED",
                run_logs=log_buf.getvalue(),
                complete_time=current_timestamp(),
            ).where(EvaluationRun.id == run_id).execute()
        finally:
            root_logger.removeHandler(log_handler)

    # ==================== Results & Analysis ====================

    @classmethod
    def list_runs(
        cls,
        user_id: str,
        dataset_id: Optional[str] = None,
        dialog_id: Optional[str] = None,
        page: int = 1,
        page_size: int = 20,
    ) -> Dict[str, Any]:
        """List evaluation runs for the current user."""
        try:
            query = EvaluationRun.select().where(
                EvaluationRun.created_by == user_id
            )

            if dataset_id:
                query = query.where(EvaluationRun.dataset_id == dataset_id)
            if dialog_id:
                query = query.where(EvaluationRun.dialog_id == dialog_id)

            query = query.order_by(EvaluationRun.create_time.desc())
            total = query.count()
            runs = query.paginate(page, page_size)
            run_dicts = [r.to_dict() for r in runs]
            for run in run_dicts:
                if run.get("status") not in {"COMPLETED", cls.RUN_STATUS_MISSING_TELEMETRY}:
                    continue
                result_rows = (
                    EvaluationResult.select()
                    .where(EvaluationResult.run_id == run["id"])
                    .order_by(EvaluationResult.create_time)
                )
                hydrated = [cls._hydrate_result_with_status(item.to_dict()) for item in result_rows]
                derived_status = cls._derive_run_status(hydrated)
                if derived_status == cls.RUN_STATUS_MISSING_TELEMETRY:
                    run["status"] = cls.RUN_STATUS_MISSING_TELEMETRY
            return {"runs": run_dicts, "total": total}
        except Exception as e:
            logging.error(f"Error listing evaluation runs: {e}")
            return {"runs": [], "total": 0}

    @classmethod
    def get_run_results(cls, run_id: str) -> Dict[str, Any]:
        """Get results for an evaluation run"""
        try:
            run = EvaluationRun.get_by_id(run_id)
            if not run:
                return {}

            results = EvaluationResult.select().where(
                EvaluationResult.run_id == run_id
            ).order_by(EvaluationResult.create_time)
            normalized_results = [cls._hydrate_result_with_status(r.to_dict()) for r in results]
            run_dict = run.to_dict()
            derived_status = cls._derive_run_status(normalized_results)
            if run_dict.get("status") in {"COMPLETED", cls.RUN_STATUS_MISSING_TELEMETRY}:
                run_dict["status"] = derived_status
            submission_path, code_archive_path = cls._artifact_paths(run_id)
            run_dict["artifacts"] = {
                "submission": {
                    "filename": submission_path.name,
                    "path": str(submission_path),
                    "exists": submission_path.exists(),
                },
                "code_archive": {
                    "filename": code_archive_path.name,
                    "path": str(code_archive_path),
                    "exists": code_archive_path.exists(),
                },
            }

            return {
                "run": run_dict,
                "results": normalized_results
            }
        except Exception as e:
            logging.error(f"Error getting run results {run_id}: {e}")
            return {}

    _CITATION_RE = re.compile(r"\s*\[ID:\d+\]")
    _FREE_TEXT_MAX_LEN = 280

    @classmethod
    def _strip_citation_markers(cls, text: str) -> str:
        return cls._CITATION_RE.sub("", text).strip()

    @classmethod
    def _coerce_answer(cls, raw: Any, answer_type: Optional[str]) -> Any:
        if raw is None or (isinstance(raw, str) and raw.strip().lower() == "null"):
            return None
        if not isinstance(raw, str):
            return raw
        cleaned = cls._strip_citation_markers(raw)
        if answer_type == "boolean":
            low = cleaned.strip().lower()
            if low == "true":
                return True
            if low == "false":
                return False
            return cleaned
        if answer_type == "number":
            stripped = cleaned.strip()
            try:
                return int(stripped)
            except ValueError:
                pass
            try:
                return float(stripped)
            except ValueError:
                return cleaned
        if answer_type == "names":
            stripped = cleaned.strip()
            if stripped.startswith("["):
                try:
                    parsed = json.loads(stripped)
                    if isinstance(parsed, list):
                        return [str(x) for x in parsed]
                except (json.JSONDecodeError, ValueError):
                    pass
            return [s.strip() for s in stripped.split(",") if s.strip()]
        if answer_type == "free_text":
            if len(cleaned) > cls._FREE_TEXT_MAX_LEN:
                cleaned = cleaned[: cls._FREE_TEXT_MAX_LEN]
            return cleaned
        return cls._strip_citation_markers(raw)

    @classmethod
    def build_submission_artifact(cls, run_id: str) -> Tuple[bool, Dict[str, Any]]:
        run_result = cls.get_run_results(run_id)
        if not run_result:
            return False, {"message": f"Evaluation run not found: {run_id}"}

        run = run_result["run"]
        results = run_result["results"]
        case_map = {
            case["id"]: case
            for case in cls.get_test_cases(run.get("dataset_id"))
        }

        answers = []
        for result in results:
            case = case_map.get(result.get("case_id"), {})
            metadata = case.get("metadata") or {}
            question_id = metadata.get("source_id") or result.get("case_id")
            answer_type = metadata.get("answer_type")
            raw_answer = result.get("generated_answer")
            answers.append(
                {
                    "question_id": question_id,
                    "answer": cls._coerce_answer(raw_answer, answer_type),
                    "telemetry": result.get("telemetry"),
                }
            )

        payload = {
            "architecture_summary": f"Generated from RAGFlow evaluation run {run_id}",
            "answers": answers,
        }

        try:
            EvaluationRun.update(submission_payload=payload).where(
                EvaluationRun.id == run_id
            ).execute()
        except Exception:
            logging.exception("Failed to persist submission_payload for run %s", run_id)

        submission_path, _ = cls._artifact_paths(run_id)
        submission_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return True, {"path": str(submission_path), "filename": submission_path.name}

    ARCHIVE_EXCLUDE_PATTERNS = [
        "*.svg", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.ico", "*.webp",
        "*.woff", "*.woff2", "*.ttf", "*.eot",
        "*.csv", "*.log", "*.log.*",
        "*.tgz", "*.tar.gz", "*.deb", "*.jar", "*.jar.*",
        "*.trie", "*.pdb", "*.tiktoken",
        "*.onnx", "*.model", "*.bin", "*.weights", "*.pt", "*.pth",
        "uv.lock", "web/package-lock.json",
        "web/public/pdfjs-dist/*",
        "web/src/stories/*",
        "rag/res/*",
        "docs/*",
        "test/*",
        "internal/*",
        "logs/*",
    ]

    ARCHIVE_SKIP_DIRS = {
        ".git", "__pycache__", "node_modules", ".venv", "venv",
        ".idea", ".vscode", ".trae", ".lh",
        ".run", ".pytest_cache", ".hypothesis",
        "data", "data_saved",
        "dist", "build", "coverage", ".next", ".nuxt", ".cache",
        "ragflow.egg-info", "ragflow_cli.egg-info",
        "ragflow-logs", "flask_session",
        "huggingface.co", "nltk_data",
        "res",
    }

    @classmethod
    def build_code_archive_artifact(cls, run_id: str) -> Tuple[bool, Dict[str, Any]]:
        _, code_archive_path = cls._artifact_paths(run_id)
        file_list = cls._collect_archivable_files()
        with zipfile.ZipFile(code_archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zip_file:
            for rel in file_list:
                file_path = cls.REPO_ROOT / rel
                if file_path.is_file():
                    zip_file.write(file_path, arcname=rel)
        return True, {"path": str(code_archive_path), "filename": code_archive_path.name}

    @classmethod
    def _is_archive_excluded(cls, rel_path: str) -> bool:
        basename = rel_path.rsplit("/", 1)[-1]
        for pat in cls.ARCHIVE_EXCLUDE_PATTERNS:
            if fnmatch.fnmatch(rel_path, pat) or fnmatch.fnmatch(basename, pat):
                return True
        return False

    @classmethod
    def _collect_archivable_files(cls) -> List[str]:
        try:
            result = subprocess.run(
                ["git", "ls-files", "-z"],
                cwd=str(cls.REPO_ROOT),
                capture_output=True,
                text=True,
                timeout=30,
            )
            result.check_returncode()
            candidates = sorted(f for f in result.stdout.split("\0") if f)
        except Exception:
            candidates = sorted(
                str(p.relative_to(cls.REPO_ROOT))
                for p in cls.REPO_ROOT.rglob("*")
                if p.is_file() and cls.ARCHIVE_SKIP_DIRS.isdisjoint(p.relative_to(cls.REPO_ROOT).parts)
            )
        return [f for f in candidates if not cls._is_archive_excluded(f)]

    @classmethod
    def get_run_artifact(cls, run_id: str, artifact_type: str) -> Tuple[bool, Dict[str, Any]]:
        run_result = cls.get_run_results(run_id)
        if not run_result:
            return False, {"message": "Evaluation run not found"}

        if artifact_type == "submission":
            success, payload = cls.build_submission_artifact(run_id)
            if not success:
                return False, payload
            return True, {**payload, "mimetype": "application/json"}

        if artifact_type == "code_archive":
            success, payload = cls.build_code_archive_artifact(run_id)
            if not success:
                return False, payload
            return True, {**payload, "mimetype": "application/zip"}

        return False, {"message": f"Unsupported artifact type: {artifact_type}"}

    @classmethod
    def prepare_submission_artifacts(cls, run_id: str) -> Tuple[bool, Dict[str, Any]]:
        success, submission_payload = cls.build_submission_artifact(run_id)
        if not success:
            return False, submission_payload
        success, archive_payload = cls.build_code_archive_artifact(run_id)
        if not success:
            return False, archive_payload
        return True, {
            "submission": submission_payload,
            "code_archive": archive_payload,
        }

    @classmethod
    def submit_run_to_platform(cls, run_id: str) -> Tuple[bool, Dict[str, Any]]:
        eval_api_key = cls._get_submission_api_key()
        if not eval_api_key:
            return False, {"message": "Submission API key is not configured"}

        eval_base_url = os.getenv(
            "EVAL_BASE_URL",
            "https://platform.agentic-challenge.ai/api/v1",
        ).strip().rstrip("/")
        submit_url = f"{eval_base_url}/submissions"

        submission_path, archive_path = cls._artifact_paths(run_id)
        if not submission_path.exists() or not archive_path.exists():
            success, payload = cls.prepare_submission_artifacts(run_id)
            if not success:
                return False, payload

        artifact_sizes = {
            "submission_size": submission_path.stat().st_size if submission_path.exists() else 0,
            "code_archive_size": archive_path.stat().st_size if archive_path.exists() else 0,
        }

        headers = {"X-API-Key": eval_api_key}
        try:
            with open(str(submission_path), "rb") as submission_file, open(
                str(archive_path), "rb"
            ) as archive_file:
                response = requests.post(
                    submit_url,
                    headers=headers,
                    files={
                        "file": (
                            submission_path.name,
                            submission_file,
                            "application/json",
                        ),
                        "code_archive": (
                            archive_path.name,
                            archive_file,
                            "application/zip",
                        ),
                    },
                    timeout=180,
                )
        except Exception as e:
            logging.exception("Failed to submit evaluation run %s", run_id)
            return False, {"message": f"Failed to submit to platform: {e}", **artifact_sizes}

        try:
            response_payload = response.json()
        except Exception:
            response_payload = {"raw_response": response.text}

        if response.status_code >= 400:
            logging.warning(
                "Submission API %s for run %s: %s",
                response.status_code, run_id, response_payload,
            )
            detail_str = json.dumps(response_payload, ensure_ascii=False)
            return False, {
                "message": f"Submission API returned {response.status_code}: {detail_str}",
                "status_code": response.status_code,
                "response": response_payload,
                **artifact_sizes,
            }

        EvaluationRun.update(is_submitted=True).where(EvaluationRun.id == run_id).execute()

        return True, {
            "status_code": response.status_code,
            "response": response_payload,
            **artifact_sizes,
        }

    # ==================== LLM Judge ====================

    DEFAULT_JUDGE_MODEL = "gpt-4.1"
    DEFAULT_JUDGE_PROMPT = (
        "You are an impartial grading judge. You will receive a QUESTION, an ANSWER produced by a RAG system, "
        "and the RETRIEVED CHUNKS that were provided to the system as context.\n\n"
        "Your task: determine whether the ANSWER is **correct and grounded** in the RETRIEVED CHUNKS.\n"
        "- score=1 (true) means the answer is factually correct given the chunks and addresses the question.\n"
        "- score=0 (false) means the answer is wrong, hallucinated, unsupported by chunks, or fails to address the question.\n\n"
        "Return ONLY valid JSON (no markdown fences) with this schema for EACH request:\n"
        '{"score": 1, "explanation": ""}\n'
        "or\n"
        '{"score": 0, "explanation": "<non-empty reason why the answer failed>"}\n\n'
        "Rules:\n"
        "- explanation MUST be empty string when score=1.\n"
        "- explanation MUST be non-empty when score=0.\n"
        "- Do NOT output anything other than the JSON object."
    )

    @classmethod
    def _resolve_judge_credentials(cls, tenant_id: str, model: str) -> Dict[str, Any]:
        from api.db.services.tenant_llm_service import TenantLLMService

        model_config = TenantLLMService.get_api_key(tenant_id, model)
        if model_config:
            return {
                "api_key": model_config.api_key or "",
                "api_base": model_config.api_base or None,
                "model_name": model_config.llm_name or model,
            }

        mdlnm, _ = TenantLLMService.split_model_name_and_factory(model)
        model_config = TenantLLMService.get_api_key(tenant_id, mdlnm)
        if model_config:
            return {
                "api_key": model_config.api_key or "",
                "api_base": model_config.api_base or None,
                "model_name": model_config.llm_name or mdlnm,
            }

        from api.db.db_models import TenantLLM
        any_openai = (
            TenantLLM.select()
            .where(
                (TenantLLM.tenant_id == tenant_id)
                & (TenantLLM.llm_factory == "OpenAI")
                & (~TenantLLM.api_key.is_null())
            )
            .first()
        )
        if any_openai:
            return {
                "api_key": any_openai.api_key or "",
                "api_base": any_openai.api_base or None,
                "model_name": mdlnm,
            }

        api_key = os.getenv("OPENAI_API_KEY", "")
        api_base = os.getenv("OPENAI_BASE_URL") or os.getenv("OPENAI_API_BASE") or None
        return {"api_key": api_key, "api_base": api_base, "model_name": mdlnm}

    @classmethod
    def run_llm_judge(
        cls,
        run_id: str,
        tenant_id: str = "",
        model: str = "",
        prompt: str = "",
        only_errors: bool = False,
        only_failed: bool = False,
    ) -> Tuple[bool, str]:
        model = (model or "").strip() or cls.DEFAULT_JUDGE_MODEL
        prompt = (prompt or "").strip() or cls.DEFAULT_JUDGE_PROMPT

        run = EvaluationRun.get_or_none(EvaluationRun.id == run_id)
        if not run:
            return False, "Evaluation run not found"
        if run.status in ("RUNNING", "PENDING"):
            return False, "Evaluation run is still in progress"

        tid = tenant_id or run.created_by
        creds = cls._resolve_judge_credentials(tid, model)
        if not creds.get("api_key"):
            return False, (
                f"No API key found for model '{model}'. "
                "Configure the model in RAGFlow's Model Providers settings."
            )

        EvaluationRun.update(
            judge_status="RUNNING",
            judge_progress=0.0,
            judge_progress_msg="0/0",
        ).where(EvaluationRun.id == run_id).execute()

        threading.Thread(
            target=cls._execute_llm_judge,
            args=(run_id, creds, model, prompt, only_errors, only_failed),
            daemon=True,
        ).start()
        return True, run_id

    @classmethod
    def _is_judge_cancelled(cls, run_id: str) -> bool:
        run = EvaluationRun.get_or_none(EvaluationRun.id == run_id)
        return run is not None and (run.judge_status or "").upper() == "CANCELLED"

    @classmethod
    def cancel_judge(cls, run_id: str) -> Tuple[bool, str]:
        run = EvaluationRun.get_or_none(EvaluationRun.id == run_id)
        if not run:
            return False, "Evaluation run not found"
        if (run.judge_status or "").upper() != "RUNNING":
            return False, "Judge is not running"
        EvaluationRun.update(judge_status="CANCELLED").where(
            EvaluationRun.id == run_id
        ).execute()
        return True, run_id

    @classmethod
    def _execute_llm_judge(
        cls,
        run_id: str,
        creds: Dict[str, Any],
        model: str,
        system_prompt: str,
        only_errors: bool = False,
        only_failed: bool = False,
    ):
        try:
            result_rows = list(
                EvaluationResult.select().where(EvaluationResult.run_id == run_id)
            )
            if not result_rows:
                EvaluationRun.update(judge_status="FAILED").where(EvaluationRun.id == run_id).execute()
                return

            run = EvaluationRun.get_or_none(EvaluationRun.id == run_id)
            dataset_id = run.dataset_id if run else None
            case_map = {}
            if dataset_id:
                case_map = {c["id"]: c for c in cls.get_test_cases(dataset_id)}

            if only_errors:
                result_rows = [
                    r for r in result_rows
                    if isinstance(r.judge_result, dict) and r.judge_result.get("score") == -1
                ]
            elif only_failed:
                result_rows = [
                    r for r in result_rows
                    if isinstance(r.judge_result, dict) and r.judge_result.get("score") == 0
                ]

            total = len(result_rows)
            done = 0
            progress_lock = threading.Lock()
            all_ok = True
            cancelled = False

            EvaluationRun.update(
                judge_progress=0.0,
                judge_progress_msg=f"0/{total}",
            ).where(EvaluationRun.id == run_id).execute()

            def _judge_one(row):
                if cls._is_judge_cancelled(run_id):
                    return None
                result_dict = row.to_dict()
                case = case_map.get(result_dict.get("case_id"), {})
                question = (
                    (case.get("metadata") or {}).get("source_question")
                    or case.get("question")
                    or ""
                )
                answer = result_dict.get("generated_answer", "")
                chunks = result_dict.get("retrieved_chunks") or []
                chunks_text = "\n---\n".join(
                    cls._chunk_to_text(c) for c in chunks if isinstance(c, dict)
                )
                user_message = (
                    f"QUESTION:\n{question}\n\n"
                    f"ANSWER:\n{answer}\n\n"
                    f"RETRIEVED CHUNKS:\n{chunks_text}"
                )
                try:
                    judge_result = cls._call_judge_llm(creds, model, system_prompt, user_message)
                except Exception as e:
                    logging.error("LLM judge call failed for result %s: %s", result_dict.get("id"), e)
                    err_str = str(e)
                    is_rate_limit = "429" in err_str or "rate_limit" in err_str.lower() or "rate limit" in err_str.lower()
                    judge_result = {
                        "score": -1 if is_rate_limit else 0,
                        "explanation": f"Judge call failed: {e}",
                    }
                EvaluationResult.update(judge_result=judge_result).where(
                    EvaluationResult.id == result_dict["id"]
                ).execute()
                return judge_result

            with ThreadPoolExecutor(max_workers=cls.MAX_CONCURRENT_JUDGE_CALLS) as executor:
                futures = {executor.submit(_judge_one, row): row for row in result_rows}
                for future in as_completed(futures):
                    if cls._is_judge_cancelled(run_id):
                        cancelled = True
                        for f in futures:
                            f.cancel()
                        break
                    try:
                        jr = future.result()
                        if jr is None:
                            cancelled = True
                            break
                        if jr.get("score") in (-1, 0) and "Judge call failed" in (jr.get("explanation") or ""):
                            all_ok = False
                    except Exception as exc:
                        logging.error("Unhandled error in judge worker: %s", exc)
                        all_ok = False
                    with progress_lock:
                        done += 1
                        EvaluationRun.update(
                            judge_progress=done / total,
                            judge_progress_msg=f"{done}/{total}",
                        ).where(EvaluationRun.id == run_id).execute()

            if cancelled:
                EvaluationRun.update(
                    judge_status="CANCELLED",
                    judge_progress=done / total if total else 0.0,
                    judge_progress_msg=f"{done}/{total}",
                ).where(EvaluationRun.id == run_id).execute()
                return

            if only_errors and all_ok:
                all_results = list(
                    EvaluationResult.select().where(EvaluationResult.run_id == run_id)
                )
                all_ok = all(
                    not (isinstance(r.judge_result, dict) and r.judge_result.get("score") in (-1, 0)
                         and "Judge call failed" in (r.judge_result.get("explanation") or ""))
                    for r in all_results
                )

            EvaluationRun.update(
                judge_status="OK" if all_ok else "FAILED",
                judge_progress=1.0,
                judge_progress_msg=f"{total}/{total}",
            ).where(EvaluationRun.id == run_id).execute()
        except Exception as e:
            logging.error("LLM judge execution failed for run %s: %s", run_id, e)
            EvaluationRun.update(judge_status="FAILED").where(EvaluationRun.id == run_id).execute()

    @classmethod
    def _chunk_to_text(cls, chunk: Dict[str, Any]) -> str:
        for key in ("content", "content_with_weight", "chunk_content", "text", "body"):
            val = chunk.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        return json.dumps(chunk, ensure_ascii=False)

    @classmethod
    def _call_judge_llm(cls, creds: Dict[str, Any], model: str, system_prompt: str, user_message: str) -> Dict[str, Any]:
        import openai

        client_kwargs: Dict[str, Any] = {"api_key": creds["api_key"]}
        if creds.get("api_base"):
            client_kwargs["base_url"] = creds["api_base"]
        client = openai.OpenAI(**client_kwargs)

        api_model = creds.get("model_name") or model
        response = client.chat.completions.create(
            model=api_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=0.0,
            max_tokens=512,
        )
        raw = (response.choices[0].message.content or "").strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```$", "", raw)
        parsed = json.loads(raw)
        score = 1 if parsed.get("score") else 0
        explanation = str(parsed.get("explanation", ""))
        if score == 1:
            explanation = ""
        return {"score": score, "explanation": explanation}

    @classmethod
    def get_recommendations(cls, run_id: str) -> List[Dict[str, Any]]:
        """
        Analyze evaluation results and provide configuration recommendations.

        Args:
            run_id: Evaluation run ID

        Returns:
            List of recommendation dictionaries
        """
        try:
            run = EvaluationRun.get_by_id(run_id)
            if not run or not run.metrics_summary:
                return []

            metrics = run.metrics_summary
            recommendations = []

            # Low precision: retrieving irrelevant chunks
            if metrics.get("avg_precision", 1.0) < 0.7:
                recommendations.append({
                    "issue": "Low Precision",
                    "severity": "high",
                    "description": "System is retrieving many irrelevant chunks",
                    "suggestions": [
                        "Increase similarity_threshold to filter out less relevant chunks",
                        "Enable reranking to improve chunk ordering",
                        "Reduce top_k to return fewer chunks"
                    ]
                })

            # Low recall: missing relevant chunks
            if metrics.get("avg_recall", 1.0) < 0.7:
                recommendations.append({
                    "issue": "Low Recall",
                    "severity": "high",
                    "description": "System is missing relevant chunks",
                    "suggestions": [
                        "Increase top_k to retrieve more chunks",
                        "Lower similarity_threshold to be more inclusive",
                        "Enable hybrid search (keyword + semantic)",
                        "Check chunk size - may be too large or too small"
                    ]
                })

            avg_total_ms = metrics.get("avg_total_time_ms", 0)
            if avg_total_ms > 5000:
                recommendations.append({
                    "issue": "Slow Response Time",
                    "severity": "medium",
                    "description": f"Average response time is {avg_total_ms / 1000:.2f}s",
                    "suggestions": [
                        "Reduce top_k to retrieve fewer chunks",
                        "Optimize embedding model selection",
                        "Consider caching frequently asked questions"
                    ]
                })

            return recommendations
        except Exception as e:
            logging.error(f"Error generating recommendations for run {run_id}: {e}")
            return []
