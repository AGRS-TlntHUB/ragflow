# Single-Shot Chat Eval Harness

`evals/single_shot_chat.py` runs one-shot evaluation for a specific chat from a JSON questions file and persists records through the evaluation APIs:

- creates an evaluation dataset bound to the chat's datasets (`kb_ids`)
- imports evaluation cases from your questions file
- starts an evaluation run for the chat
- polls until completion and prints run summary
- optionally saves full run payload to local JSON

## Required inputs

- `--chat-id`
- `--questions-dataset-path`

## Configuration

The script infers RAGFlow API URL from the currently running Docker container port mapping.

API key is read from `evals/.env`:

```bash
RAGFLOW_API_KEY=<your_ragflow_api_key>
```

## Example

```bash
source .venv/bin/activate
python evals/single_shot_chat.py \
  --chat-id "<chat_id>" \
  --questions-dataset-path "data_saved/public_dataset/1_question.json"
```

Optional: print inferred endpoint/version before execution:

```bash
python evals/single_shot_chat.py \
  --chat-id "<chat_id>" \
  --questions-dataset-path "data_saved/public_dataset/1_question.json" \
  --print-resolved-config
```

`--questions-dataset-path` accepts absolute paths, or repo-relative paths (for example `data_saved/...`) resolved from the `ragflow/` root.

## Output

The script prints:

- `dataset_id`: created evaluation dataset id
- `run_id`: created evaluation run id
- `status`: run terminal status (`COMPLETED` or `FAILED`)
- import and result counts
- `metrics_summary`: summary metrics from the run

By default it also writes `run_result_<run_id>.json` to the current directory. Use `--no-artifact` to skip, or `--artifact-path` to set a custom path.
