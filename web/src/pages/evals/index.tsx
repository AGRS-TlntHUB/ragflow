import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import evaluationService from '@/services/evaluation-service';
import chatService from '@/services/next-chat-service';
import { formatDate, formatSecondsToHumanReadable } from '@/utils/date';
import { useQuery } from '@tanstack/react-query';
import { message } from 'antd';
import { LucideSend, LucideSettings, LucideTrash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type EvaluationRun = {
  id: string;
  dataset_id: string;
  dialog_id: string;
  name?: string;
  status: string;
  create_time: number;
  complete_time?: number;
};

type EvaluationResult = {
  id: string;
  case_id: string;
  generated_answer: string;
  execution_time: number;
  retrieved_chunks?: Record<string, unknown>[];
};

type EvaluationCase = {
  id: string;
  question: string;
  metadata?: {
    answer_type?: string;
    source_question?: string;
  };
};

type EvalTemplate = {
  id: string;
  name: string;
  chatId: string;
  datasetPath: string;
  datasetContent: string;
};

const DEFAULT_CHAT_ID = 'b50544e222a411f18adca3e91c097350';
const DEFAULT_QUESTIONS_DATASET_PATH =
  'data_saved/public_dataset/1_question.json';
const DEFAULT_QUESTIONS_DATASET_CONTENT = `[
  {
    "question": "Who were the claimants in case CFI 010/2024?",
    "answer_type": "names",
    "id": "cdddeb6a063f29cbea5f10b3dccbd83aa16849e1f3124e223d141d1578efeb0a"
  }
]`;
const ALL_TYPES_MINIMAL_DATASET_PATH =
  'data_saved/public_dataset/all_types_questions_minimal.json';
const ALL_TYPES_MINIMAL_DATASET_CONTENT = `[
  {
    "question": "Who were the claimants in case CFI 010/2024?",
    "answer_type": "names",
    "id": "cdddeb6a063f29cbea5f10b3dccbd83aa16849e1f3124e223d141d1578efeb0a"
  },
  {
    "question": "Summarize the court's final ruling in case CFI 010/2024.",
    "answer_type": "free_text",
    "id": "6618184ee84fbebc360162dc3825868eec4e5e81aae1901eb18a8e741fd323f3"
  },
  {
    "question": "Was the main claim or application in case ARB 034/2025 approved or granted by the court?",
    "answer_type": "boolean",
    "id": "df0f24b2b339c62162b82eb3add3a2a71a275ee768fbb2835ccdd66bc79cd04f"
  },
  {
    "question": "What was the claim value referenced in the appeal judgment CA 005/2025?",
    "answer_type": "number",
    "id": "d204a13070fd2f18eb3e9e939fdc80855a915dfafd7f49f8fc8e80d6a3d7637b"
  },
  {
    "question": "Which case was decided earlier: CFI 016/2025 or ENF 269/2023?",
    "answer_type": "name",
    "id": "b9dc2dae206c155bc5936c971272e8154d22b4f9e3fa65795eb8b49a80d26b6f"
  },
  {
    "question": "On what date was the Employment Law Amendment Law enacted?",
    "answer_type": "date",
    "id": "dd97e6cdec41ef77576ed86e037565fc88ff891edcdd39018e2d062e28f9605f"
  }
]`;

const buildTemplateId = () =>
  `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const createTemplate = (
  name: string,
  chatId: string = DEFAULT_CHAT_ID,
  datasetPath: string = DEFAULT_QUESTIONS_DATASET_PATH,
  datasetContent: string = DEFAULT_QUESTIONS_DATASET_CONTENT,
): EvalTemplate => ({
  id: buildTemplateId(),
  name,
  chatId,
  datasetPath,
  datasetContent,
});

const formatDatasetPathForCard = (datasetPath: string) => {
  if (!datasetPath) {
    return '-';
  }
  const normalized = datasetPath.replace(/\\/g, '/');
  const fileName = normalized.split('/').filter(Boolean).pop() || normalized;
  return `.../${fileName}`;
};

const formatQuestionWithAnswerType = (
  question: string,
  answerType?: string,
) => {
  if (!answerType) {
    return question;
  }
  return `${question}\n\nRequested answer type: ${answerType}.\nReturn only in this format.`;
};

const buildCasesFromDatasetContent = (datasetContent: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(datasetContent);
  } catch {
    throw new Error('Dataset file is not valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Dataset file must be a JSON array');
  }
  if (parsed.length === 0) {
    throw new Error('Dataset file is empty');
  }

  return parsed.map((item, idx) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Dataset entry #${idx + 1} must be an object`);
    }
    const row = item as Record<string, unknown>;
    const rawQuestion = row.question;
    if (typeof rawQuestion !== 'string' || !rawQuestion.trim()) {
      throw new Error(`Dataset entry #${idx + 1} has missing/empty "question"`);
    }

    const question = rawQuestion.trim();
    const rawAnswerType = row.answer_type;
    const answerType =
      typeof rawAnswerType === 'string' && rawAnswerType.trim()
        ? rawAnswerType.trim()
        : undefined;

    const metadata: Record<string, unknown> = {};
    if (row.id !== null && row.id !== undefined && row.id !== '') {
      metadata.source_id = row.id;
    }
    if (answerType) {
      metadata.answer_type = answerType;
      metadata.source_question = question;
    }

    const caseData: Record<string, unknown> = {
      question: formatQuestionWithAnswerType(question, answerType),
    };
    if (Object.keys(metadata).length > 0) {
      caseData.metadata = metadata;
    }
    return caseData;
  });
};

export default function Evals() {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<EvalTemplate[]>([
    createTemplate('Single-Shot Chat (public)'),
    createTemplate(
      'Single-Shot Chat (all types minimal)',
      DEFAULT_CHAT_ID,
      ALL_TYPES_MINIMAL_DATASET_PATH,
      ALL_TYPES_MINIMAL_DATASET_CONTENT,
    ),
  ]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [settingsTemplateId, setSettingsTemplateId] = useState<string>('');
  const [runningTemplateId, setRunningTemplateId] = useState('');
  const [pendingRunTemplateId, setPendingRunTemplateId] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [selectedResultId, setSelectedResultId] = useState<string>('');
  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === selectedTemplateId),
    [templates, selectedTemplateId],
  );

  const {
    data: runsData,
    isLoading: runsLoading,
    refetch: refetchRuns,
  } = useQuery({
    queryKey: ['evaluationRuns', selectedTemplate?.chatId || ''],
    queryFn: async () => {
      if (!selectedTemplate?.chatId) {
        return { runs: [], total: 0 } as {
          runs: EvaluationRun[];
          total: number;
        };
      }
      const { data: response } = await evaluationService.listEvaluationRuns(
        {
          params: {
            page: 1,
            page_size: 500,
            dialog_id: selectedTemplate.chatId,
          },
          headers: { 'X-Skip-Error-Notification': '1' },
        },
        true,
      );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to fetch evaluation runs');
      }
      return response.data as { runs: EvaluationRun[]; total: number };
    },
  });

  const runs = useMemo(() => runsData?.runs || [], [runsData]);
  const runsForSelectedTemplate = useMemo(() => {
    if (!selectedTemplate) {
      return [] as EvaluationRun[];
    }
    const prefix = `${selectedTemplate.name} run `;
    return runs.filter((run) => (run.name || '').startsWith(prefix));
  }, [runs, selectedTemplate]);

  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [selectedTemplateId, templates]);

  useEffect(() => {
    if (!selectedRunId && runsForSelectedTemplate.length > 0) {
      setSelectedRunId(runsForSelectedTemplate[0].id);
    }
  }, [runsForSelectedTemplate, selectedRunId]);

  useEffect(() => {
    if (!runsLoading && runsForSelectedTemplate.length === 0) {
      setSelectedRunId('');
      setSelectedResultId('');
    }
  }, [runsForSelectedTemplate, runsLoading]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }
    const exists = runsForSelectedTemplate.some(
      (run) => run.id === selectedRunId,
    );
    if (!exists) {
      setSelectedRunId('');
    }
  }, [runsForSelectedTemplate, selectedRunId]);

  const selectedRun = useMemo(
    () => runsForSelectedTemplate.find((x) => x.id === selectedRunId),
    [runsForSelectedTemplate, selectedRunId],
  );

  const { data: runDetailData, isLoading: runDetailLoading } = useQuery({
    queryKey: ['evaluationRunDetail', selectedRun?.id || ''],
    enabled: !!selectedRun?.id,
    queryFn: async () => {
      const { data: response } = await evaluationService.getEvaluationRun(
        selectedRun!.id,
      );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to fetch evaluation run');
      }
      return response.data as {
        run: EvaluationRun;
        results: EvaluationResult[];
      };
    },
  });

  const { data: casesData } = useQuery({
    queryKey: ['evaluationCases', selectedRun?.dataset_id],
    enabled: !!selectedRun?.dataset_id,
    queryFn: async () => {
      if (!selectedRun?.dataset_id) {
        return { cases: [], total: 0 } as {
          cases: EvaluationCase[];
          total: number;
        };
      }
      const { data: response } =
        await evaluationService.getEvaluationDatasetCases(
          selectedRun.dataset_id,
        );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to fetch evaluation cases');
      }
      return response.data as { cases: EvaluationCase[]; total: number };
    },
  });

  const caseMap = useMemo(() => {
    const map = new Map<string, EvaluationCase>();
    (casesData?.cases || []).forEach((item) => map.set(item.id, item));
    return map;
  }, [casesData]);

  const results = selectedRun ? runDetailData?.results || [] : [];
  const isSuccess = (selectedRun?.status || '').toUpperCase() === 'COMPLETED';
  const artifactPath = selectedRun ? `run_result_${selectedRun.id}.json` : '-';
  const selectedResult = useMemo(
    () => results.find((item) => item.id === selectedResultId),
    [results, selectedResultId],
  );

  useEffect(() => {
    setSelectedResultId('');
  }, [selectedRunId]);

  useEffect(() => {
    if (results.length === 0) {
      setSelectedResultId('');
      return;
    }
    const isValid = results.some((item) => item.id === selectedResultId);
    if (!isValid) {
      setSelectedResultId(results[0].id);
    }
  }, [results, selectedResultId]);

  const updateTemplate = (
    templateId: string,
    updater: (template: EvalTemplate) => EvalTemplate,
  ) => {
    setTemplates((prev) =>
      prev.map((item) => (item.id === templateId ? updater(item) : item)),
    );
  };

  const handleDeleteTemplate = (templateId: string) => {
    let nextSelectedTemplateId = '';
    setTemplates((prev) => {
      const filtered = prev.filter((item) => item.id !== templateId);
      nextSelectedTemplateId = filtered[0]?.id || '';
      return filtered;
    });
    setSelectedTemplateId((prev) =>
      prev === templateId ? nextSelectedTemplateId : prev,
    );
    if (settingsTemplateId === templateId) {
      setSettingsTemplateId('');
    }
    if (pendingRunTemplateId === templateId) {
      setPendingRunTemplateId('');
    }
  };

  const handleRunTemplate = async (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) {
      return;
    }

    try {
      if (!template.chatId?.trim()) {
        throw new Error('Template chat ID is required');
      }
      if (!template.datasetPath?.trim()) {
        throw new Error('Questions dataset path is required');
      }
      const cases = buildCasesFromDatasetContent(template.datasetContent);
      setRunningTemplateId(templateId);

      const { data: dialogResponse } = await chatService.getDialog(
        {
          params: { dialogId: template.chatId },
          headers: { 'X-Skip-Error-Notification': '1' },
        },
        true,
      );
      if (dialogResponse.code !== 0) {
        throw new Error(dialogResponse.message || 'Failed to fetch chat');
      }
      const dialog = dialogResponse.data || {};
      const kbIds = Array.isArray(dialog.kb_ids) ? dialog.kb_ids : [];
      if (!kbIds.length) {
        throw new Error('Selected chat has no datasets attached');
      }

      const now = new Date();
      const timestamp = now
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '')
        .slice(0, 19);

      const { data: createDatasetResponse } =
        await evaluationService.createEvaluationDataset(
          {
            data: {
              name: `${template.name} ${timestamp}`,
              description: `Created from template ${template.name} (${template.datasetPath})`,
              kb_ids: kbIds,
            },
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );
      if (createDatasetResponse.code !== 0) {
        throw new Error(
          createDatasetResponse.message ||
            'Failed to create evaluation dataset',
        );
      }
      const datasetId = createDatasetResponse.data?.dataset_id;
      if (!datasetId) {
        throw new Error('Missing dataset_id from create dataset response');
      }

      const { data: importResponse } =
        await evaluationService.importEvaluationDatasetCases(
          {
            datasetId,
            data: { cases },
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );
      if (importResponse.code !== 0) {
        throw new Error(importResponse.message || 'Failed to import cases');
      }

      const { data: startRunResponse } =
        await evaluationService.startEvaluationRun(
          {
            data: {
              dataset_id: datasetId,
              dialog_id: template.chatId,
              name: `${template.name} run ${timestamp}`,
            },
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );
      if (startRunResponse.code !== 0) {
        throw new Error(startRunResponse.message || 'Failed to start run');
      }
      const runId = startRunResponse.data?.run_id;
      if (!runId) {
        throw new Error('Missing run_id from start run response');
      }

      setSelectedTemplateId(templateId);
      await refetchRuns();
      setSelectedRunId(runId);
      message.success('Evaluation run started');
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : 'Failed to run evaluation template',
      );
    } finally {
      setRunningTemplateId('');
    }
  };

  const stringifyValue = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    if (Array.isArray(value))
      return value.map((item) => stringifyValue(item)).join(', ');
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
    return '';
  };

  const getChunkField = (chunk: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      const value = stringifyValue(chunk[key]);
      if (value) {
        return value;
      }
    }
    return '';
  };

  const selectedRetrievedChunks = selectedResult?.retrieved_chunks || [];
  const averageExecutionTime = useMemo(() => {
    if (results.length === 0) {
      return null;
    }
    const total = results.reduce(
      (sum, result) => sum + (result.execution_time || 0),
      0,
    );
    return total / results.length;
  }, [results]);

  return (
    <article className="size-full p-5 flex gap-4 overflow-hidden">
      <aside className="w-72 shrink-0 rounded-xl border border-border-default bg-bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default text-sm font-medium">
          Eval templates
        </div>
        <ScrollArea className="h-[calc(100%-49px)]">
          <div className="p-2 space-y-1">
            {templates.map((template) => {
              const active = template.id === selectedTemplateId;
              const running = runningTemplateId === template.id;
              return (
                <div
                  key={template.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedTemplateId(template.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedTemplateId(template.id);
                    }
                  }}
                  className={`w-full rounded-md border px-3 py-2 text-sm transition-colors ${
                    active
                      ? 'border-accent-primary bg-accent-primary-5'
                      : 'border-border-default hover:bg-fill-tertiary'
                  }`}
                >
                  <div className="w-full text-left mb-2">
                    <div className="font-medium break-words">
                      {template.name}
                    </div>
                    <div className="text-xs text-text-secondary break-all mt-1">
                      {formatDatasetPathForCard(template.datasetPath)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label="Template settings"
                      onClick={() => {
                        setSelectedTemplateId(template.id);
                        setSettingsTemplateId(template.id);
                      }}
                      className="size-7 inline-flex items-center justify-center rounded-md hover:bg-fill-secondary"
                    >
                      <LucideSettings className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Run template"
                      onClick={() => {
                        setSelectedTemplateId(template.id);
                        setPendingRunTemplateId(template.id);
                      }}
                      disabled={running}
                      className="size-7 inline-flex items-center justify-center rounded-md hover:bg-fill-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <LucideSend className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete template"
                      onClick={() => handleDeleteTemplate(template.id)}
                      className="size-7 inline-flex items-center justify-center rounded-md hover:bg-fill-secondary"
                    >
                      <LucideTrash2 className="size-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </aside>

      <aside className="w-64 shrink-0 rounded-xl border border-border-default bg-bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default text-sm font-medium">
          Evals
        </div>
        <ScrollArea className="h-[calc(100%-49px)]">
          <div className="p-2 space-y-1">
            {runsForSelectedTemplate.map((run) => {
              const active = run.id === selectedRunId;
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    active
                      ? 'bg-accent-primary-5 text-accent-primary'
                      : 'hover:bg-fill-tertiary'
                  }`}
                >
                  {formatDate(run.create_time)}
                </button>
              );
            })}
            {!runsLoading && runsForSelectedTemplate.length === 0 && (
              <div className="px-3 py-2 text-sm text-text-secondary">
                {t('common.noData')}
              </div>
            )}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex-1 rounded-xl border border-border-default bg-bg-card flex flex-col min-h-0 overflow-hidden">
        {selectedRun ? (
          <>
            <header className="px-4 py-3 border-b border-border-default">
              <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-sm">
                <div className="text-text-secondary">Chat ID</div>
                <code className="break-all">{selectedRun.dialog_id}</code>
                <div className="text-text-secondary">Artifact path</div>
                <code className="break-all">{artifactPath}</code>
                <div className="text-text-secondary">Avg exec time</div>
                <div>
                  {averageExecutionTime === null
                    ? '-'
                    : formatSecondsToHumanReadable(averageExecutionTime)}
                </div>
                <div className="text-text-secondary">{t('common.action')}</div>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${isSuccess ? 'bg-state-success' : 'bg-state-error'}`}
                  />
                  <span>{isSuccess ? 'Success' : 'Failed'}</span>
                </div>
              </div>
            </header>

            <ScrollArea className="flex-1 min-h-0">
              <div className="p-4 space-y-3">
                {results.map((result) => {
                  const active = result.id === selectedResultId;
                  const caseItem = caseMap.get(result.case_id);
                  const answerType = caseItem?.metadata?.answer_type;
                  const displayQuestion =
                    caseItem?.metadata?.source_question ||
                    caseItem?.question ||
                    '-';

                  return (
                    <div
                      key={result.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedResultId(result.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedResultId(result.id);
                        }
                      }}
                      className={`w-full text-left rounded-lg border p-4 transition-colors ${
                        active
                          ? 'border-accent-primary bg-accent-primary-5'
                          : 'border-border-default bg-bg-base hover:bg-fill-tertiary'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-4 mb-2">
                        <div className="flex items-center gap-2">
                          <div className="font-medium">Question</div>
                          {answerType && (
                            <span className="px-2 py-0.5 rounded-md text-xs bg-fill-tertiary text-text-secondary">
                              {answerType}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-text-secondary">
                          {formatSecondsToHumanReadable(
                            result.execution_time || 0,
                          )}
                        </div>
                      </div>
                      <div className="text-sm mb-4 break-words whitespace-pre-wrap select-text">
                        {displayQuestion}
                      </div>
                      <div className="font-medium mb-2">Answer</div>
                      <div className="text-sm break-words whitespace-pre-wrap select-text">
                        {result.generated_answer || '-'}
                      </div>
                    </div>
                  );
                })}
                {!runDetailLoading && results.length === 0 && (
                  <div className="text-sm text-text-secondary">
                    {t('common.noData')}
                  </div>
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-text-secondary">
            {runsLoading ? 'Loading...' : t('common.noData')}
          </div>
        )}
      </section>

      <section className="flex-1 rounded-xl border border-border-default bg-bg-card flex flex-col min-h-0 overflow-hidden">
        <header className="px-4 py-3 border-b border-border-default text-sm font-medium">
          Retrieved chunks
          {selectedResult ? ` (${selectedRetrievedChunks.length})` : ''}
        </header>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 space-y-3">
            {selectedResult &&
              selectedRetrievedChunks.map((chunk, idx) => {
                const chunkId =
                  getChunkField(chunk, ['id', 'chunk_id', '_id']) ||
                  `#${idx + 1}`;
                const content =
                  getChunkField(chunk, [
                    'content',
                    'content_with_weight',
                    'chunk_content',
                    'text',
                    'body',
                  ]) || '-';
                const documentName =
                  getChunkField(chunk, [
                    'document_name',
                    'docnm_kwd',
                    'doc_name',
                    'doc_id',
                  ]) || '-';
                const rawChunk = stringifyValue(chunk);
                const hasFallbackFields =
                  chunkId !== `#${idx + 1}` ||
                  content !== '-' ||
                  documentName !== '-';

                return (
                  <div
                    key={`${chunkId}-${idx}`}
                    className="rounded-lg border border-border-default p-4 bg-bg-base"
                  >
                    <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-sm">
                      <div className="text-text-secondary">Chunk ID</div>
                      <code className="break-all">{chunkId}</code>
                      <div className="text-text-secondary">Document</div>
                      <div className="break-all">{documentName}</div>
                      <div className="text-text-secondary">Content</div>
                      <div className="break-words">{content}</div>
                      {!hasFallbackFields && (
                        <>
                          <div className="text-text-secondary">Raw</div>
                          <code className="break-all">{rawChunk || '-'}</code>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            {(!selectedResult || selectedRetrievedChunks.length === 0) && (
              <div className="text-sm text-text-secondary">
                {t('common.noData')}
              </div>
            )}
          </div>
        </ScrollArea>
      </section>

      <Dialog
        open={!!settingsTemplateId}
        onOpenChange={(open) => !open && setSettingsTemplateId('')}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Template settings</DialogTitle>
          </DialogHeader>
          {settingsTemplateId && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="text-sm text-text-secondary">Template name</div>
                <input
                  value={
                    templates.find((item) => item.id === settingsTemplateId)
                      ?.name || ''
                  }
                  onChange={(event) =>
                    updateTemplate(settingsTemplateId, (template) => ({
                      ...template,
                      name: event.target.value,
                    }))
                  }
                  className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm text-text-secondary">Chat ID</div>
                <input
                  value={
                    templates.find((item) => item.id === settingsTemplateId)
                      ?.chatId || ''
                  }
                  className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                  readOnly
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm text-text-secondary">
                  Questions Dataset path
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm flex items-center overflow-hidden text-ellipsis whitespace-nowrap">
                    {templates.find((item) => item.id === settingsTemplateId)
                      ?.datasetPath || '-'}
                  </div>
                  <button
                    type="button"
                    className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
                    onClick={async () => {
                      const datasetPath =
                        templates.find((item) => item.id === settingsTemplateId)
                          ?.datasetPath || '';
                      if (!datasetPath) {
                        return;
                      }
                      try {
                        await navigator.clipboard.writeText(datasetPath);
                        message.success('Questions dataset path copied');
                      } catch {
                        message.error('Failed to copy path');
                      }
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <button
              type="button"
              className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
              onClick={() => setSettingsTemplateId('')}
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!pendingRunTemplateId}
        onOpenChange={(open) => !open && setPendingRunTemplateId('')}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run evaluation?</AlertDialogTitle>
            <AlertDialogDescription>
              Run the selected eval template with current settings?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingRunTemplateId('')}>
              No
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const templateId = pendingRunTemplateId;
                setPendingRunTemplateId('');
                if (templateId) {
                  void handleRunTemplate(templateId);
                }
              }}
            >
              Yes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
