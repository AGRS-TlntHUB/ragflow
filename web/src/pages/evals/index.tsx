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
import {
  LucideFileText,
  LucideSend,
  LucideSettings,
  LucideTrash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type EvaluationRun = {
  id: string;
  dataset_id: string;
  dialog_id: string;
  name?: string;
  status: string;
  progress?: number;
  progress_msg?: string;
  create_time: number;
  complete_time?: number;
  metrics_summary?: {
    total_cases?: number;
    ok_cases?: number;
    missing_telemetry_cases?: number;
    failed_cases?: number;
    telemetry_complete_rate?: number;
  };
};

type EvaluationTelemetry = {
  timing?: {
    ttft_ms?: number | null;
    tpot_ms?: number | null;
    total_time_ms?: number | null;
  };
  retrieval?: {
    retrieved_chunk_pages?: Array<{
      doc_id: string;
      page_numbers: number[];
    }>;
  };
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
  };
  model_name?: string | null;
};

type EvaluationResult = {
  id: string;
  case_id: string;
  generated_answer: string;
  execution_time: number;
  retrieved_chunks?: Record<string, unknown>[];
  telemetry?: EvaluationTelemetry;
  case_status?: string;
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
  eval_type: string;
  dataset_id: string;
  dataset_path: string;
  dataset_content: string;
  script_path?: string;
};

const getTemplateRunTag = (templateId: string) => `[tpl:${templateId}]`;

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

const normalizeStatus = (status: string) => (status || '').toUpperCase();

const isRunInProgress = (status: string) => {
  const s = normalizeStatus(status);
  return s === 'RUNNING' || s === 'PENDING';
};

const getRunStatusMeta = (status: string) => {
  const normalizedStatus = normalizeStatus(status);
  if (normalizedStatus === 'COMPLETED') {
    return { label: 'Success', dotClassName: 'bg-state-success' };
  }
  if (normalizedStatus === 'MISSING_TELEMETRY') {
    return { label: 'Missing telemetry', dotClassName: 'bg-state-warning' };
  }
  if (normalizedStatus === 'RUNNING' || normalizedStatus === 'PENDING') {
    return { label: 'Running', dotClassName: 'bg-state-info' };
  }
  return { label: 'Failed', dotClassName: 'bg-state-error' };
};

const getCaseStatusMeta = (status?: string) => {
  const normalizedStatus = normalizeStatus(status || '');
  if (normalizedStatus === 'MISSING_TELEMETRY') {
    return {
      label: 'Missing telemetry',
      className: 'bg-state-warning/15 text-state-warning',
    };
  }
  if (normalizedStatus === 'FAILED') {
    return {
      label: 'Failed',
      className: 'bg-state-error/10 text-state-error',
    };
  }
  return {
    label: 'Success',
    className: 'bg-state-success/10 text-state-success',
  };
};

const formatMs = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

function TelemetryDetails({ telemetry }: { telemetry: EvaluationTelemetry }) {
  const timing = telemetry.timing;
  const usage = telemetry.usage;
  const retrieval = telemetry.retrieval;
  const chunkPages = retrieval?.retrieved_chunk_pages || [];

  return (
    <div className="mt-4 pt-4 border-t border-border-default space-y-3">
      <div className="font-medium text-xs uppercase tracking-wide text-text-secondary">
        Telemetry
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <span className="text-text-secondary">Model</span>
          <div className="font-mono text-xs mt-0.5 break-all">
            {telemetry.model_name || '-'}
          </div>
        </div>
        <div>
          <span className="text-text-secondary">Total time</span>
          <div className="font-mono text-xs mt-0.5">
            {formatMs(timing?.total_time_ms)}
          </div>
        </div>
        <div>
          <span className="text-text-secondary">TTFT</span>
          <div className="font-mono text-xs mt-0.5">
            {formatMs(timing?.ttft_ms)}
          </div>
        </div>
        <div>
          <span className="text-text-secondary">TPOT</span>
          <div className="font-mono text-xs mt-0.5">
            {formatMs(timing?.tpot_ms)}
          </div>
        </div>
        <div>
          <span className="text-text-secondary">Input tokens</span>
          <div className="font-mono text-xs mt-0.5">
            {usage?.input_tokens ?? '-'}
          </div>
        </div>
        <div>
          <span className="text-text-secondary">Output tokens</span>
          <div className="font-mono text-xs mt-0.5">
            {usage?.output_tokens ?? '-'}
          </div>
        </div>
      </div>
      {chunkPages.length > 0 && (
        <div className="text-sm">
          <span className="text-text-secondary">Retrieved pages</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {chunkPages.map((entry) => (
              <span
                key={entry.doc_id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-fill-tertiary"
              >
                <span className="font-medium truncate max-w-[140px]">
                  {entry.doc_id}
                </span>
                <span className="text-text-secondary">
                  p.{entry.page_numbers.join(', ')}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Evals() {
  const { t } = useTranslation();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [settingsTemplateId, setSettingsTemplateId] = useState<string>('');
  const [runningTemplateId, setRunningTemplateId] = useState('');
  const [pendingRunTemplateId, setPendingRunTemplateId] = useState('');
  const [isAddTemplateOpen, setIsAddTemplateOpen] = useState(false);
  const [newTemplateEvalType, setNewTemplateEvalType] = useState('');
  const [newTemplateDatasetPath, setNewTemplateDatasetPath] = useState('');
  const [newTemplateDialogId, setNewTemplateDialogId] = useState('');
  const { data: templateTypesData, isLoading: templateTypesLoading } = useQuery(
    {
      queryKey: ['evaluationTemplateTypes'],
      queryFn: async () => {
        const { data: response } =
          await evaluationService.listEvaluationTemplateTypes(
            {
              headers: { 'X-Skip-Error-Notification': '1' },
            },
            true,
          );
        if (response.code !== 0) {
          throw new Error(
            response.message || 'Failed to fetch evaluation types',
          );
        }
        return response.data as {
          types: Array<{ eval_type: string; script_path: string }>;
        };
      },
    },
  );
  const templateTypes = templateTypesData?.types || [];
  const fallbackEvalType = templateTypes[0]?.eval_type || 'Single-Shot Chat';
  const {
    data: templatesData,
    isLoading: templatesLoading,
    refetch: refetchTemplates,
  } = useQuery({
    queryKey: ['evaluationTemplates'],
    queryFn: async () => {
      const { data: response } =
        await evaluationService.listEvaluationTemplates(
          {
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to fetch templates');
      }
      return response.data as { templates: EvalTemplate[]; total: number };
    },
  });
  const templates = templatesData?.templates || [];
  const { data: availableDialogs = [], isFetching: availableDialogsLoading } =
    useQuery<Array<{ id: string; name: string }>>({
      queryKey: ['evalTemplateAvailableDialogs', isAddTemplateOpen],
      enabled: isAddTemplateOpen,
      queryFn: async () => {
        const { data: response } =
          await evaluationService.listAvailableDialogsForEval(
            { headers: { 'X-Skip-Error-Notification': '1' } },
            true,
          );
        if (response.code !== 0) {
          throw new Error(
            response.message || 'Failed to fetch available chat apps',
          );
        }
        return response.data?.dialogs || [];
      },
      staleTime: 60_000,
    });
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [selectedResultId, setSelectedResultId] = useState<string>('');
  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === selectedTemplateId),
    [templates, selectedTemplateId],
  );
  const { data: templateDialogNames } = useQuery({
    queryKey: [
      'evalTemplateDialogNames',
      templates
        .map((item) => item.dataset_id)
        .filter(Boolean)
        .sort()
        .join(','),
    ],
    queryFn: async () => {
      const uniqueDialogIds = Array.from(
        new Set(
          templates.map((item) => item.dataset_id).filter((item) => !!item),
        ),
      );
      const entries = await Promise.all(
        uniqueDialogIds.map(async (dialogId) => {
          try {
            const { data: response } = await chatService.getDialog(
              { params: { dialogId } },
              true,
            );
            const dialogName =
              response?.code === 0 ? response?.data?.name : undefined;
            return [dialogId, dialogName || dialogId] as const;
          } catch {
            return [dialogId, dialogId] as const;
          }
        }),
      );
      return Object.fromEntries(entries) as Record<string, string>;
    },
    enabled: templates.length > 0,
  });

  const {
    data: runsData,
    isLoading: runsLoading,
    refetch: refetchRuns,
  } = useQuery({
    queryKey: ['evaluationRuns'],
    queryFn: async () => {
      const { data: response } = await evaluationService.listEvaluationRuns(
        {
          params: {
            page: 1,
            page_size: 500,
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
    refetchInterval: (query) => {
      const data = query.state.data as { runs: EvaluationRun[] } | undefined;
      const hasRunning = (data?.runs || []).some((r) =>
        isRunInProgress(r.status),
      );
      return hasRunning ? 2000 : false;
    },
  });

  const runs = useMemo(() => runsData?.runs || [], [runsData]);
  const runsForSelectedTemplate = useMemo(() => {
    if (!selectedTemplate) {
      return [] as EvaluationRun[];
    }
    const runTag = getTemplateRunTag(selectedTemplate.id);
    return runs.filter((run) => (run.name || '').includes(runTag));
  }, [runs, selectedTemplate]);

  useEffect(() => {
    if (!selectedTemplateId && templates.length > 0) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [selectedTemplateId, templates, templatesLoading]);

  useEffect(() => {
    if (!selectedRunId && runsForSelectedTemplate.length > 0) {
      const firstClickable = runsForSelectedTemplate.find(
        (r) => !isRunInProgress(r.status),
      );
      if (firstClickable) {
        setSelectedRunId(firstClickable.id);
      }
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

  useEffect(() => {
    if (!isAddTemplateOpen) {
      return;
    }
    if (!newTemplateEvalType && templateTypes.length > 0) {
      setNewTemplateEvalType(templateTypes[0].eval_type);
    }
    if (newTemplateDialogId) {
      return;
    }
    if (availableDialogs.length > 0) {
      setNewTemplateDialogId(availableDialogs[0].id);
    }
  }, [
    isAddTemplateOpen,
    newTemplateDialogId,
    availableDialogs,
    setNewTemplateDialogId,
    newTemplateEvalType,
    templateTypes,
  ]);

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
  const runStatusMeta = getRunStatusMeta(selectedRun?.status || '');
  const canDownloadArtifacts = !['RUNNING', 'PENDING'].includes(
    normalizeStatus(selectedRun?.status || ''),
  );
  const artifactPath = selectedRun ? `run_result_${selectedRun.id}.json` : '-';
  const [artifactLoading, setArtifactLoading] = useState<
    'submission' | 'code_archive' | ''
  >('');
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsContent, setLogsContent] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
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

  const handleDeleteTemplate = async (templateId: string) => {
    try {
      const { data: response } =
        await evaluationService.deleteEvaluationTemplate(templateId, true);
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to delete template');
      }
      const currentSelectedTemplateId = selectedTemplateId;
      const nextTemplatesData = await refetchTemplates();
      const nextTemplates = nextTemplatesData.data?.templates || [];
      if (currentSelectedTemplateId === templateId) {
        setSelectedTemplateId(nextTemplates[0]?.id || '');
      }
      message.success('Template deleted');
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : 'Failed to delete template',
      );
    }
    if (settingsTemplateId === templateId) {
      setSettingsTemplateId('');
    }
    if (pendingRunTemplateId === templateId) {
      setPendingRunTemplateId('');
    }
  };

  const handleCreateTemplate = () => {
    const evalType = newTemplateEvalType.trim();
    const datasetPath = newTemplateDatasetPath.trim();
    const dialogId = newTemplateDialogId.trim();
    if (!evalType) {
      message.error('Eval type is required');
      return;
    }
    if (!datasetPath) {
      message.error('Local eval JSON dataset path is required');
      return;
    }
    if (!dialogId) {
      message.error('Chat app is required');
      return;
    }
    void (async () => {
      try {
        const { data: response } =
          await evaluationService.createEvaluationTemplate(
            {
              data: {
                eval_type: evalType,
                dataset_id: dialogId,
                dataset_path: datasetPath,
              },
              headers: { 'X-Skip-Error-Notification': '1' },
            },
            true,
          );
        if (response.code !== 0) {
          throw new Error(response.message || 'Failed to create template');
        }
        const templateId = response.data?.template_id;
        const nextTemplatesData = await refetchTemplates();
        const nextTemplates = nextTemplatesData.data?.templates || [];
        setSelectedTemplateId(templateId || nextTemplates[0]?.id || '');
        setIsAddTemplateOpen(false);
        setNewTemplateEvalType(templateTypes[0]?.eval_type || '');
        setNewTemplateDatasetPath('');
        setNewTemplateDialogId('');
        message.success('Template added');
      } catch (error) {
        message.error(
          error instanceof Error ? error.message : 'Failed to create template',
        );
      }
    })();
  };

  const handleRunTemplate = async (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) {
      return;
    }

    try {
      const templateDialogId = template.dataset_id?.trim();
      if (!templateDialogId) {
        throw new Error('Template chat app is required');
      }
      if (!template.dataset_path?.trim()) {
        throw new Error('Questions dataset path is required');
      }
      if (!template.dataset_content?.trim()) {
        throw new Error('Questions dataset content is empty');
      }
      const cases = buildCasesFromDatasetContent(template.dataset_content);
      setRunningTemplateId(templateId);

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
              name: `${template.eval_type} ${timestamp}`,
              description: `Created from template ${template.eval_type} (${template.dataset_path})`,
              kb_ids: [],
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
              dialog_id: templateDialogId,
              name: `${template.eval_type} run ${timestamp} ${getTemplateRunTag(template.id)}`,
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

  const triggerArtifactDownload = (blob: Blob, filename: string) => {
    const blobUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(blobUrl);
  };

  const handleDownloadArtifact = async (
    artifactType: 'submission' | 'code_archive',
  ) => {
    if (!selectedRun?.id) {
      return;
    }
    setArtifactLoading(artifactType);
    try {
      const commonConfig = {
        runId: selectedRun.id,
        responseType: 'blob' as const,
        headers: { 'X-Skip-Error-Notification': '1' },
      };
      const response =
        artifactType === 'submission'
          ? await evaluationService.downloadEvaluationSubmissionArtifact(
              commonConfig,
              true,
            )
          : await evaluationService.downloadEvaluationCodeArchiveArtifact(
              commonConfig,
              true,
            );
      const filename =
        artifactType === 'submission'
          ? `submission_${selectedRun.id}.json`
          : `code_archive_${selectedRun.id}.zip`;
      triggerArtifactDownload(response.data as Blob, filename);
      message.success(
        artifactType === 'submission'
          ? 'submission.json downloaded'
          : 'code_archive.zip downloaded',
      );
    } catch {
      message.error(
        artifactType === 'submission'
          ? 'Failed to download submission.json'
          : 'Failed to download code_archive.zip',
      );
    } finally {
      setArtifactLoading('');
    }
  };

  const handleShowLogs = async () => {
    if (!selectedRun?.id) return;
    setLogsLoading(true);
    setLogsOpen(true);
    try {
      const { data: response } = await evaluationService.getEvaluationRunLogs(
        selectedRun.id,
      );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to fetch logs');
      }
      setLogsContent(response.data?.logs || '(no logs captured)');
    } catch {
      setLogsContent('Failed to load logs.');
    } finally {
      setLogsLoading(false);
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
                      {template.eval_type}
                    </div>
                    <div className="text-xs text-text-secondary break-all mt-1">
                      {templateDialogNames?.[template.dataset_id] || '-'}
                    </div>
                    <div className="text-xs text-text-secondary break-all mt-1">
                      {formatDatasetPathForCard(template.dataset_path)}
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
                      onClick={() => {
                        void handleDeleteTemplate(template.id);
                      }}
                      className="size-7 inline-flex items-center justify-center rounded-md hover:bg-fill-secondary"
                    >
                      <LucideTrash2 className="size-4" />
                    </button>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              className="w-full rounded-md border border-dashed border-border-default px-3 py-2 text-sm text-text-secondary hover:bg-fill-tertiary"
              onClick={() => setIsAddTemplateOpen(true)}
            >
              + Add evaluation
            </button>
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
              const running = isRunInProgress(run.status);
              const pct = Math.round((run.progress || 0) * 100);
              return (
                <button
                  key={run.id}
                  type="button"
                  disabled={running}
                  onClick={() => setSelectedRunId(run.id)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    running
                      ? 'opacity-70 cursor-default'
                      : active
                        ? 'bg-accent-primary-5 text-accent-primary'
                        : 'hover:bg-fill-tertiary'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate">
                      {formatDate(run.create_time)}
                    </span>
                    {running && (
                      <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
                        <span className="text-[10px] tabular-nums text-text-secondary whitespace-nowrap">
                          {run.progress_msg || `${pct}%`}
                        </span>
                        <div className="w-14 h-1.5 rounded-full bg-fill-tertiary overflow-hidden">
                          <div
                            className="h-full rounded-full bg-accent-primary transition-all duration-500"
                            style={{
                              width: `${Math.max(4, pct)}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
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
                <div className="text-text-secondary">Eval type</div>
                <div>{selectedTemplate?.eval_type || fallbackEvalType}</div>
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
                    className={`w-2 h-2 rounded-full ${runStatusMeta.dotClassName}`}
                  />
                  <span>{runStatusMeta.label}</span>
                  {canDownloadArtifacts && (
                    <button
                      type="button"
                      onClick={handleShowLogs}
                      className="h-7 px-2 rounded-md border border-border-default text-xs hover:bg-fill-tertiary inline-flex items-center gap-1"
                    >
                      <LucideFileText className="size-3.5" />
                      Show logs
                    </button>
                  )}
                </div>
                <div className="text-text-secondary">Download artifacts</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void handleDownloadArtifact('submission');
                    }}
                    disabled={
                      !selectedRun?.id ||
                      artifactLoading !== '' ||
                      !canDownloadArtifacts
                    }
                    className="h-8 px-2 rounded-md border border-border-default text-xs disabled:opacity-50"
                  >
                    {artifactLoading === 'submission'
                      ? 'Downloading...'
                      : 'Download submission.json'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleDownloadArtifact('code_archive');
                    }}
                    disabled={
                      !selectedRun?.id ||
                      artifactLoading !== '' ||
                      !canDownloadArtifacts
                    }
                    className="h-8 px-2 rounded-md border border-border-default text-xs disabled:opacity-50"
                  >
                    {artifactLoading === 'code_archive'
                      ? 'Downloading...'
                      : 'Download code_archive.zip'}
                  </button>
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
                          <span
                            className={`px-2 py-0.5 rounded-md text-xs ${getCaseStatusMeta(result.case_status).className}`}
                          >
                            {getCaseStatusMeta(result.case_status).label}
                          </span>
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

                      {active && result.telemetry && (
                        <TelemetryDetails telemetry={result.telemetry} />
                      )}
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

      <Dialog open={isAddTemplateOpen} onOpenChange={setIsAddTemplateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add evaluation template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm text-text-secondary">Eval type</div>
              <select
                value={newTemplateEvalType}
                onChange={(event) => setNewTemplateEvalType(event.target.value)}
                className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                disabled={templateTypesLoading}
              >
                {templateTypes.length === 0 && (
                  <option value="">
                    {templateTypesLoading
                      ? 'Loading eval types...'
                      : 'No eval types'}
                  </option>
                )}
                {templateTypes.map((item) => (
                  <option key={item.eval_type} value={item.eval_type}>
                    {item.eval_type}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <div className="text-sm text-text-secondary">
                Local eval JSON dataset path
              </div>
              <input
                value={newTemplateDatasetPath}
                onChange={(event) =>
                  setNewTemplateDatasetPath(event.target.value)
                }
                placeholder="data/public_dataset.json"
                className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm text-text-secondary">Chat app</div>
              <select
                value={newTemplateDialogId}
                onChange={(event) => setNewTemplateDialogId(event.target.value)}
                className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                disabled={availableDialogsLoading}
              >
                {availableDialogs.length === 0 && (
                  <option value="">
                    {availableDialogsLoading
                      ? 'Loading chat apps...'
                      : 'No chat apps'}
                  </option>
                )}
                {availableDialogs.map((dialog) => (
                  <option key={dialog.id} value={dialog.id}>
                    {dialog.name} ({dialog.id})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
              onClick={() => setIsAddTemplateOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
              onClick={handleCreateTemplate}
            >
              Add
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                <div className="text-sm text-text-secondary">
                  Eval template type
                </div>
                <input
                  value={
                    templates.find((item) => item.id === settingsTemplateId)
                      ?.eval_type || ''
                  }
                  className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                  readOnly
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm text-text-secondary">Chat app</div>
                <input
                  value={
                    templateDialogNames?.[
                      templates.find((item) => item.id === settingsTemplateId)
                        ?.dataset_id || ''
                    ] || ''
                  }
                  className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                  readOnly
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm text-text-secondary">Chat app ID</div>
                <input
                  value={
                    templates.find((item) => item.id === settingsTemplateId)
                      ?.dataset_id || ''
                  }
                  className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                  readOnly
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm text-text-secondary">
                  Questions file path
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm flex items-center overflow-hidden text-ellipsis whitespace-nowrap">
                    {templates.find((item) => item.id === settingsTemplateId)
                      ?.dataset_path || '-'}
                  </div>
                  <button
                    type="button"
                    className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
                    onClick={async () => {
                      const datasetPath =
                        templates.find((item) => item.id === settingsTemplateId)
                          ?.dataset_path || '';
                      if (!datasetPath) {
                        return;
                      }
                      try {
                        await navigator.clipboard.writeText(datasetPath);
                        message.success('Path copied');
                      } catch {
                        message.error('Failed to copy path');
                      }
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-sm text-text-secondary">
                  Executable script
                </div>
                <input
                  value={
                    templates.find((item) => item.id === settingsTemplateId)
                      ?.script_path || '-'
                  }
                  className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                  readOnly
                />
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

      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Run logs</DialogTitle>
          </DialogHeader>
          <ScrollArea className="flex-1 min-h-0 max-h-[60vh]">
            {logsLoading ? (
              <div className="p-4 text-sm text-text-secondary">Loading...</div>
            ) : (
              <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-words bg-bg-base rounded-md border border-border-default">
                {logsContent}
              </pre>
            )}
          </ScrollArea>
          <DialogFooter>
            <button
              type="button"
              className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
              onClick={() => setLogsOpen(false)}
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}
