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
RAG Evaluation API Endpoints

Provides REST API for RAG evaluation functionality including:
- Dataset management
- Test case management
- Evaluation execution
- Results retrieval
- Configuration recommendations
"""

from pathlib import Path
from quart import request, send_file
from api.apps import login_required, current_user
from api.db.services.evaluation_service import EvaluationService
from api.utils.api_utils import (
    get_data_error_result,
    get_json_result,
    get_request_json,
    server_error_response,
    validate_request
)
from common.constants import RetCode, StatusEnum


# ==================== Template Management ====================

@manager.route('/template/types', methods=['GET'])  # noqa: F821
@login_required
async def list_eval_template_types():
    """List available eval type to script mappings"""
    try:
        mappings = EvaluationService.list_eval_type_scripts(
            tenant_id=current_user.id,
            user_id=current_user.id,
        )
        return get_json_result(data={"types": mappings})
    except Exception as e:
        return server_error_response(e)


@manager.route('/template/list', methods=['GET'])  # noqa: F821
@login_required
async def list_eval_templates():
    """List evaluation templates for current tenant"""
    try:
        templates = EvaluationService.list_eval_templates(
            tenant_id=current_user.id,
            user_id=current_user.id,
        )
        return get_json_result(data={"templates": templates, "total": len(templates)})
    except Exception as e:
        return server_error_response(e)


@manager.route('/template/create', methods=['POST'])  # noqa: F821
@login_required
@validate_request("eval_type", "dataset_id", "dataset_path")
async def create_eval_template():
    """Create an evaluation template"""
    try:
        req = await get_request_json()
        eval_type = req.get("eval_type", "").strip()
        dataset_id = req.get("dataset_id", "").strip()
        dataset_path = req.get("dataset_path", "").strip()

        if not eval_type:
            return get_data_error_result(message="eval_type cannot be empty")
        if not dataset_id:
            return get_data_error_result(message="dataset_id cannot be empty")
        if not dataset_path:
            return get_data_error_result(message="dataset_path cannot be empty")

        success, result = EvaluationService.create_eval_template(
            tenant_id=current_user.id,
            user_id=current_user.id,
            eval_type=eval_type,
            dataset_id=dataset_id,
            dataset_path=dataset_path,
        )
        if not success:
            return get_data_error_result(message=result)
        return get_json_result(data={"template_id": result})
    except Exception as e:
        return server_error_response(e)


@manager.route('/template/<template_id>', methods=['DELETE'])  # noqa: F821
@login_required
async def delete_eval_template(template_id):
    """Delete an evaluation template (soft delete)"""
    try:
        success = EvaluationService.delete_eval_template(
            template_id=template_id,
            tenant_id=current_user.id,
        )
        if not success:
            return get_data_error_result(message="Failed to delete evaluation template")
        return get_json_result(data={"template_id": template_id})
    except Exception as e:
        return server_error_response(e)


# ==================== Knowledge Base Lookup ====================

@manager.route('/kb/available', methods=['GET'])  # noqa: F821
@login_required
async def list_available_kbs():
    """List all active knowledge bases across tenants for evaluation."""
    try:
        from api.db.db_models import Knowledgebase
        kbs = (
            Knowledgebase.select()
            .where(Knowledgebase.status == StatusEnum.VALID.value)
            .order_by(Knowledgebase.create_time.desc())
        )
        return get_json_result(data={"kbs": [{"id": kb.id, "name": kb.name} for kb in kbs]})
    except Exception as e:
        return server_error_response(e)


# ==================== Dialog Lookup ====================

@manager.route('/dialog/available', methods=['GET'])  # noqa: F821
@login_required
async def list_available_dialogs():
    """List all active chat apps (dialogs) for evaluation."""
    try:
        from api.db.db_models import Dialog
        dialogs = (
            Dialog.select()
            .where(Dialog.status == StatusEnum.VALID.value)
            .order_by(Dialog.create_time.desc())
        )
        return get_json_result(data={
            "dialogs": [{"id": d.id, "name": d.name} for d in dialogs]
        })
    except Exception as e:
        return server_error_response(e)


# ==================== Dataset Management ====================

@manager.route('/dataset/create', methods=['POST'])  # noqa: F821
@login_required
@validate_request("name")
async def create_dataset():
    """
    Create a new evaluation dataset.
    
    Request body:
    {
        "name": "Dataset name",
        "description": "Optional description",
        "kb_ids": ["kb_id1", "kb_id2"]  (optional)
    }
    """
    try:
        req = await get_request_json()
        name = req.get("name", "").strip()
        description = req.get("description", "")
        kb_ids = req.get("kb_ids", [])
        
        if not name:
            return get_data_error_result(message="Dataset name cannot be empty")
        
        if not isinstance(kb_ids, list):
            return get_data_error_result(message="kb_ids must be a list")
        
        success, result = EvaluationService.create_dataset(
            name=name,
            description=description,
            kb_ids=kb_ids,
            tenant_id=current_user.id,
            user_id=current_user.id
        )
        
        if not success:
            return get_data_error_result(message=result)
        
        return get_json_result(data={"dataset_id": result})
    except Exception as e:
        return server_error_response(e)


@manager.route('/dataset/list', methods=['GET'])  # noqa: F821
@login_required
async def list_datasets():
    """
    List evaluation datasets for current tenant.
    
    Query params:
    - page: Page number (default: 1)
    - page_size: Items per page (default: 20)
    """
    try:
        page = int(request.args.get("page", 1))
        page_size = int(request.args.get("page_size", 20))
        
        result = EvaluationService.list_datasets(
            tenant_id=current_user.id,
            user_id=current_user.id,
            page=page,
            page_size=page_size
        )
        
        return get_json_result(data=result)
    except Exception as e:
        return server_error_response(e)


@manager.route('/dataset/<dataset_id>', methods=['GET'])  # noqa: F821
@login_required
async def get_dataset(dataset_id):
    """Get dataset details by ID"""
    try:
        dataset = EvaluationService.get_dataset(dataset_id)
        if not dataset:
            return get_data_error_result(
                message="Dataset not found",
                code=RetCode.DATA_ERROR
            )
        
        return get_json_result(data=dataset)
    except Exception as e:
        return server_error_response(e)


@manager.route('/dataset/<dataset_id>', methods=['PUT'])  # noqa: F821
@login_required
async def update_dataset(dataset_id):
    """
    Update dataset.
    
    Request body:
    {
        "name": "New name",
        "description": "New description",
        "kb_ids": ["kb_id1", "kb_id2"]
    }
    """
    try:
        req = await get_request_json()
        
        # Remove fields that shouldn't be updated
        req.pop("id", None)
        req.pop("tenant_id", None)
        req.pop("created_by", None)
        req.pop("create_time", None)
        
        success = EvaluationService.update_dataset(dataset_id, **req)
        
        if not success:
            return get_data_error_result(message="Failed to update dataset")
        
        return get_json_result(data={"dataset_id": dataset_id})
    except Exception as e:
        return server_error_response(e)


@manager.route('/dataset/<dataset_id>', methods=['DELETE'])  # noqa: F821
@login_required
async def delete_dataset(dataset_id):
    """Delete dataset (soft delete)"""
    try:
        success = EvaluationService.delete_dataset(dataset_id)
        
        if not success:
            return get_data_error_result(message="Failed to delete dataset")
        
        return get_json_result(data={"dataset_id": dataset_id})
    except Exception as e:
        return server_error_response(e)


# ==================== Test Case Management ====================

@manager.route('/dataset/<dataset_id>/case/add', methods=['POST'])  # noqa: F821
@login_required
@validate_request("question")
async def add_test_case(dataset_id):
    """
    Add a test case to a dataset.
    
    Request body:
    {
        "question": "Test question",
        "reference_answer": "Optional ground truth answer",
        "relevant_doc_ids": ["doc_id1", "doc_id2"],
        "relevant_chunk_ids": ["chunk_id1", "chunk_id2"],
        "metadata": {"key": "value"}
    }
    """
    try:
        req = await get_request_json()
        question = req.get("question", "").strip()
        
        if not question:
            return get_data_error_result(message="Question cannot be empty")
        
        success, result = EvaluationService.add_test_case(
            dataset_id=dataset_id,
            question=question,
            reference_answer=req.get("reference_answer"),
            relevant_doc_ids=req.get("relevant_doc_ids"),
            relevant_chunk_ids=req.get("relevant_chunk_ids"),
            metadata=req.get("metadata")
        )
        
        if not success:
            return get_data_error_result(message=result)
        
        return get_json_result(data={"case_id": result})
    except Exception as e:
        return server_error_response(e)


@manager.route('/dataset/<dataset_id>/case/import', methods=['POST'])  # noqa: F821
@login_required
@validate_request("cases")
async def import_test_cases(dataset_id):
    """
    Bulk import test cases.
    
    Request body:
    {
        "cases": [
            {
                "question": "Question 1",
                "reference_answer": "Answer 1",
                ...
            },
            {
                "question": "Question 2",
                ...
            }
        ]
    }
    """
    try:
        req = await get_request_json()
        cases = req.get("cases", [])
        
        if not cases or not isinstance(cases, list):
            return get_data_error_result(message="cases must be a non-empty list")
        
        success_count, failure_count = EvaluationService.import_test_cases(
            dataset_id=dataset_id,
            cases=cases
        )
        
        return get_json_result(data={
            "success_count": success_count,
            "failure_count": failure_count,
            "total": len(cases)
        })
    except Exception as e:
        return server_error_response(e)


@manager.route('/dataset/<dataset_id>/cases', methods=['GET'])  # noqa: F821
@login_required
async def get_test_cases(dataset_id):
    """Get all test cases for a dataset"""
    try:
        cases = EvaluationService.get_test_cases(dataset_id)
        return get_json_result(data={"cases": cases, "total": len(cases)})
    except Exception as e:
        return server_error_response(e)


@manager.route('/case/<case_id>', methods=['DELETE'])  # noqa: F821
@login_required
async def delete_test_case(case_id):
    """Delete a test case"""
    try:
        success = EvaluationService.delete_test_case(case_id)
        
        if not success:
            return get_data_error_result(message="Failed to delete test case")
        
        return get_json_result(data={"case_id": case_id})
    except Exception as e:
        return server_error_response(e)


# ==================== Evaluation Execution ====================

@manager.route('/run/start', methods=['POST'])  # noqa: F821
@login_required
@validate_request("dataset_id", "dialog_id")
async def start_evaluation():
    """
    Start an evaluation run.
    
    Request body:
    {
        "dataset_id": "dataset_id",
        "dialog_id": "dialog_id",
        "name": "Optional run name"
    }
    """
    try:
        req = await get_request_json()
        dataset_id = req.get("dataset_id")
        dialog_id = req.get("dialog_id")
        name = req.get("name")
        parallel = req.get("parallel", True)
        raw_max_workers = req.get("max_workers")
        max_workers = int(raw_max_workers) if raw_max_workers is not None else None
        if max_workers is not None and max_workers < 1:
            return get_data_error_result(message="max_workers must be >= 1")

        success, result = EvaluationService.start_evaluation(
            dataset_id=dataset_id,
            dialog_id=dialog_id,
            user_id=current_user.id,
            name=name,
            parallel=bool(parallel),
            max_workers=max_workers,
        )

        if not success:
            return get_data_error_result(message=result)

        return get_json_result(data={"run_id": result})
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>', methods=['GET'])  # noqa: F821
@login_required
async def get_evaluation_run(run_id):
    """Get evaluation run details"""
    try:
        result = EvaluationService.get_run_results(run_id)
        
        if not result:
            return get_data_error_result(
                message="Evaluation run not found",
                code=RetCode.DATA_ERROR
            )
        
        return get_json_result(data=result)
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>/logs', methods=['GET'])  # noqa: F821
@login_required
async def get_run_logs(run_id):
    """Get execution logs for an evaluation run"""
    try:
        from api.db.db_models import EvaluationRun as EvalRunModel
        run = EvalRunModel.get_or_none(EvalRunModel.id == run_id)
        if not run:
            return get_data_error_result(
                message="Evaluation run not found",
                code=RetCode.DATA_ERROR
            )
        return get_json_result(data={"run_id": run_id, "logs": run.run_logs or ""})
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>/results', methods=['GET'])  # noqa: F821
@login_required
async def get_run_results(run_id):
    """Get detailed results for an evaluation run"""
    try:
        result = EvaluationService.get_run_results(run_id)
        
        if not result:
            return get_data_error_result(
                message="Evaluation run not found",
                code=RetCode.DATA_ERROR
            )
        
        return get_json_result(data=result)
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/list', methods=['GET'])  # noqa: F821
@login_required
async def list_evaluation_runs():
    """
    List evaluation runs.
    
    Query params:
    - dataset_id: Filter by dataset (optional)
    - dialog_id: Filter by dialog (optional)
    - page: Page number (default: 1)
    - page_size: Items per page (default: 20)
    """
    try:
        page = int(request.args.get("page", 1))
        page_size = int(request.args.get("page_size", 20))
        dataset_id = request.args.get("dataset_id")
        dialog_id = request.args.get("dialog_id")

        result = EvaluationService.list_runs(
            user_id=current_user.id,
            dataset_id=dataset_id,
            dialog_id=dialog_id,
            page=page,
            page_size=page_size,
        )
        return get_json_result(data=result)
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>/rerun_failed', methods=['POST'])  # noqa: F821
@login_required
async def rerun_failed(run_id):
    """Create a new run that copies OK results and re-runs failed/missing-telemetry cases."""
    try:
        success, result = EvaluationService.rerun_failed(
            source_run_id=run_id,
            user_id=current_user.id,
        )
        if not success:
            return get_data_error_result(message=result)
        return get_json_result(data={"run_id": result})
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>/prepare_artifacts', methods=['POST'])  # noqa: F821
@login_required
async def prepare_artifacts(run_id):
    """Build submission.json and code_archive.zip without uploading."""
    try:
        success, result = EvaluationService.prepare_submission_artifacts(run_id)
        if not success:
            return get_json_result(
                code=RetCode.DATA_ERROR,
                message=result.get("message", "Failed to prepare artifacts"),
                data=result,
            )
        return get_json_result(data=result)
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>/submit', methods=['POST'])  # noqa: F821
@login_required
async def submit_run(run_id):
    """Upload pre-built artifacts to the challenge platform."""
    try:
        success, result = EvaluationService.submit_run_to_platform(run_id)
        if not success:
            return get_json_result(
                code=RetCode.DATA_ERROR,
                message=result.get("message", "Failed to submit run"),
                data=result,
            )
        return get_json_result(data=result)
    except Exception as e:
        return server_error_response(e)


@manager.route('/submission_api_key', methods=['GET'])  # noqa: F821
@login_required
async def get_submission_api_key_status():
    try:
        return get_json_result(
            data={"has_api_key": EvaluationService.has_submission_api_key()}
        )
    except Exception as e:
        return server_error_response(e)


@manager.route('/submission_api_key', methods=['POST'])  # noqa: F821
@login_required
@validate_request("api_key")
async def set_submission_api_key():
    try:
        req = await get_request_json()
        success, msg = EvaluationService.set_submission_api_key(req.get("api_key", ""))
        if not success:
            return get_data_error_result(message=msg)
        return get_json_result(data={"has_api_key": True})
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>/judge', methods=['POST'])  # noqa: F821
@login_required
async def run_llm_judge(run_id):
    """Run LLM-as-a-judge on a completed evaluation run."""
    try:
        req = await get_request_json()
        model = req.get("model", "")
        prompt = req.get("prompt", "")
        only_errors = bool(req.get("only_errors", False))
        only_failed = bool(req.get("only_failed", False))
        success, result = EvaluationService.run_llm_judge(
            run_id=run_id,
            tenant_id=current_user.id,
            model=model,
            prompt=prompt,
            only_errors=only_errors,
            only_failed=only_failed,
        )
        if not success:
            return get_data_error_result(message=result)
        return get_json_result(data={"run_id": result})
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>/judge/cancel', methods=['POST'])  # noqa: F821
@login_required
async def cancel_llm_judge(run_id):
    try:
        success, result = EvaluationService.cancel_judge(run_id)
        if not success:
            return get_data_error_result(message=result)
        return get_json_result(data={"run_id": result})
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>', methods=['DELETE'])  # noqa: F821
@login_required
async def delete_evaluation_run(run_id):
    """Delete an evaluation run"""
    try:
        # TODO: Implement delete_run in EvaluationService
        return get_json_result(data={"run_id": run_id})
    except Exception as e:
        return server_error_response(e)


# ==================== Analysis & Recommendations ====================

@manager.route('/run/<run_id>/recommendations', methods=['GET'])  # noqa: F821
@login_required
async def get_recommendations(run_id):
    """Get configuration recommendations based on evaluation results"""
    try:
        recommendations = EvaluationService.get_recommendations(run_id)
        return get_json_result(data={"recommendations": recommendations})
    except Exception as e:
        return server_error_response(e)


@manager.route('/compare', methods=['POST'])  # noqa: F821
@login_required
@validate_request("run_ids")
async def compare_runs():
    """
    Compare multiple evaluation runs.
    
    Request body:
    {
        "run_ids": ["run_id1", "run_id2", "run_id3"]
    }
    """
    try:
        req = await get_request_json()
        run_ids = req.get("run_ids", [])
        
        if not run_ids or not isinstance(run_ids, list) or len(run_ids) < 2:
            return get_data_error_result(
                message="run_ids must be a list with at least 2 run IDs"
            )
        
        # TODO: Implement compare_runs in EvaluationService
        return get_json_result(data={"comparison": {}})
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>/export', methods=['GET'])  # noqa: F821
@login_required
async def export_results(run_id):
    """Export evaluation results as JSON/CSV"""
    try:
        # format_type = request.args.get("format", "json")  # TODO: Use for CSV export
        
        result = EvaluationService.get_run_results(run_id)
        
        if not result:
            return get_data_error_result(
                message="Evaluation run not found",
                code=RetCode.DATA_ERROR
            )
        
        return get_json_result(data=result)
    except Exception as e:
        return server_error_response(e)


@manager.route('/run/<run_id>/artifact/<artifact_type>', methods=['GET'])  # noqa: F821
@login_required
async def download_run_artifact(run_id, artifact_type):
    """Generate and download run artifacts: submission/code_archive"""
    try:
        success, payload = EvaluationService.get_run_artifact(run_id, artifact_type)
        if not success:
            return get_data_error_result(
                message=payload.get("message", "Failed to generate run artifact"),
                code=RetCode.DATA_ERROR,
            )

        file_path = payload.get("path")
        if not file_path:
            return get_data_error_result(
                message="Artifact path is missing",
                code=RetCode.DATA_ERROR,
            )

        path_obj = Path(file_path)
        if not path_obj.exists() or not path_obj.is_file():
            return get_data_error_result(
                message="Artifact file not found",
                code=RetCode.DATA_ERROR,
            )

        return await send_file(
            str(path_obj),
            as_attachment=True,
            attachment_filename=payload.get("filename", path_obj.name),
            mimetype=payload.get("mimetype", "application/octet-stream"),
        )
    except Exception as e:
        return server_error_response(e)


# ==================== Real-time Evaluation ====================

@manager.route('/evaluate_single', methods=['POST'])  # noqa: F821
@login_required
@validate_request("question", "dialog_id")
async def evaluate_single():
    """
    Evaluate a single question-answer pair in real-time.
    
    Request body:
    {
        "question": "Test question",
        "dialog_id": "dialog_id",
        "reference_answer": "Optional ground truth",
        "relevant_chunk_ids": ["chunk_id1", "chunk_id2"]
    }
    """
    try:
        # req = await get_request_json()  # TODO: Use for single evaluation implementation
        
        # TODO: Implement single evaluation
        # This would execute the RAG pipeline and return metrics immediately
        
        return get_json_result(data={
            "answer": "",
            "metrics": {},
            "retrieved_chunks": []
        })
    except Exception as e:
        return server_error_response(e)
