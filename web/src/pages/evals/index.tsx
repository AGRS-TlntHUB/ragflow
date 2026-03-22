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
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import evaluationService from '@/services/evaluation-service';
import chatService from '@/services/next-chat-service';
import { formatDate, formatSecondsToHumanReadable } from '@/utils/date';
import { useQuery } from '@tanstack/react-query';
import { message } from 'antd';
import {
  LucideFileText,
  LucideRefreshCw,
  LucideScale,
  LucideSend,
  LucideSettings,
  LucideTrash2,
  LucideX,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type EvaluationRun = {
  id: string;
  dataset_id: string;
  dialog_id: string;
  name?: string;
  status: string;
  is_submitted?: boolean;
  progress?: number;
  progress_msg?: string;
  create_time: number;
  complete_time?: number;
  judge_status?: string | null;
  judge_progress?: number;
  judge_progress_msg?: string;
  metrics_summary?: {
    total_cases?: number;
    ok_cases?: number;
    missing_telemetry_cases?: number;
    failed_cases?: number;
    telemetry_complete_rate?: number;
    run_duration_s?: number;
    sum_execution_time_s?: number;
    avg_ttft_ms?: number;
    avg_tpot_ms?: number;
    avg_total_time_ms?: number;
    avg_input_tokens?: number;
    avg_output_tokens?: number;
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
  judge_result?: { score: number; explanation: string } | null;
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

type SubmitDialogStatus =
  | 'confirm'
  | 'preparing'
  | 'sending'
  | 'success'
  | 'error';

const getTemplateRunTag = (templateId: string) => `[tpl:${templateId}]`;

const formatDatasetPathForCard = (datasetPath: string) => {
  if (!datasetPath) {
    return '-';
  }
  const parts = datasetPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const tail =
    parts.length >= 2 ? parts.slice(-2).join('/') : parts[0] || datasetPath;
  return `../${tail}`;
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

const hasJudgeResult = (
  jr: { score: number; explanation: string } | null | undefined,
): jr is { score: number; explanation: string } =>
  jr != null &&
  typeof jr === 'object' &&
  (jr.score === 0 || jr.score === 1 || jr.score === -1);

const isJudgeError = (
  jr: { score: number; explanation: string } | null | undefined,
): boolean => jr != null && typeof jr === 'object' && jr.score === -1;

const formatMs = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const formatBytes = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined || bytes === 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const formatFailedPercent = (
  failedCount: number,
  totalCount: number | undefined,
) => {
  if (!totalCount) return '-';
  return `${((failedCount / totalCount) * 100).toFixed(1)}%`;
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
  const [pendingDeleteTemplateId, setPendingDeleteTemplateId] = useState('');
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
      const runs = data?.runs || [];
      const hasRunning = runs.some((r) => isRunInProgress(r.status));
      const hasJudgeRunning = runs.some(
        (r) => (r.judge_status || '').toUpperCase() === 'RUNNING',
      );
      return hasRunning || hasJudgeRunning ? 2000 : false;
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
    refetchInterval: (query) => {
      const data = query.state.data as { run: EvaluationRun } | undefined;
      const js = (data?.run?.judge_status || '').toUpperCase();
      const rs = (data?.run?.status || '').toUpperCase();
      return js === 'RUNNING' || rs === 'RUNNING' || rs === 'PENDING'
        ? 2000
        : false;
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
  const effectiveJudgeStatus =
    runDetailData?.run?.judge_status ?? selectedRun?.judge_status ?? null;
  const isJudgeRunning =
    (effectiveJudgeStatus || '').toUpperCase() === 'RUNNING';
  const judgeProgress =
    runDetailData?.run?.judge_progress ?? selectedRun?.judge_progress ?? 0;
  const judgeProgressMsg =
    runDetailData?.run?.judge_progress_msg ??
    selectedRun?.judge_progress_msg ??
    '';
  const judgeProgressPct = Math.round((judgeProgress || 0) * 100);
  const runStatusMeta = getRunStatusMeta(selectedRun?.status || '');
  const canDownloadArtifacts = !['RUNNING', 'PENDING'].includes(
    normalizeStatus(selectedRun?.status || ''),
  );
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);
  const [submitDialogStatus, setSubmitDialogStatus] =
    useState<SubmitDialogStatus>('confirm');
  const [prepareProgress, setPrepareProgress] = useState(0);
  const [sendProgress, setSendProgress] = useState(0);
  const [submitMessage, setSubmitMessage] = useState('');
  const [submitArtifactSizes, setSubmitArtifactSizes] = useState<{
    submission_size?: number;
    code_archive_size?: number;
  }>({});
  const progressIntervalRef = useRef<number | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsContent, setLogsContent] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [showOnlyJudgeFailed, setShowOnlyJudgeFailed] = useState(false);
  const [showOnlyJudgeErrors, setShowOnlyJudgeErrors] = useState(false);
  const [templateEvalSettings, setTemplateEvalSettings] = useState<
    Record<string, { parallel: boolean; maxWorkers: number }>
  >({});
  const filteredResults = useMemo(() => {
    let filtered = results;
    if (showOnlyJudgeFailed) {
      filtered = filtered.filter(
        (r) => hasJudgeResult(r.judge_result) && r.judge_result.score === 0,
      );
    }
    if (showOnlyJudgeErrors) {
      filtered = filtered.filter((r) => isJudgeError(r.judge_result));
    }
    return filtered;
  }, [results, showOnlyJudgeFailed, showOnlyJudgeErrors]);
  const selectedResult = useMemo(
    () => filteredResults.find((item) => item.id === selectedResultId),
    [filteredResults, selectedResultId],
  );

  useEffect(() => {
    setSelectedResultId('');
  }, [selectedRunId]);

  useEffect(() => {
    if (filteredResults.length === 0) {
      setSelectedResultId('');
      return;
    }
    const isValid = filteredResults.some(
      (item) => item.id === selectedResultId,
    );
    if (!isValid) {
      setSelectedResultId(filteredResults[0].id);
    }
  }, [filteredResults, selectedResultId]);

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

      const settings = templateEvalSettings[templateId] ?? {
        parallel: true,
        maxWorkers: 50,
      };
      const { data: startRunResponse } =
        await evaluationService.startEvaluationRun(
          {
            data: {
              dataset_id: datasetId,
              dialog_id: templateDialogId,
              name: `${template.eval_type} run ${timestamp} ${getTemplateRunTag(template.id)}`,
              parallel: settings.parallel,
              max_workers: settings.parallel ? settings.maxWorkers : undefined,
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

  const clearProgressInterval = () => {
    if (progressIntervalRef.current !== null) {
      window.clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  };

  const startFakeProgress = (
    setter: React.Dispatch<React.SetStateAction<number>>,
    cap = 90,
    step = 5,
    intervalMs = 300,
  ) => {
    clearProgressInterval();
    setter(5);
    progressIntervalRef.current = window.setInterval(() => {
      setter((prev) => (prev >= cap ? prev : prev + step));
    }, intervalMs);
  };

  const handleSubmitDialogOpenChange = (open: boolean) => {
    if (
      !open &&
      (submitDialogStatus === 'preparing' || submitDialogStatus === 'sending')
    ) {
      return;
    }
    if (!open) {
      clearProgressInterval();
    }
    setSubmitDialogOpen(open);
  };

  const handleSubmitRun = async () => {
    if (!selectedRun?.id || !canDownloadArtifacts) {
      return;
    }

    setPrepareProgress(0);
    setSendProgress(0);
    setSubmitMessage('');
    setSubmitArtifactSizes({});

    setSubmitDialogStatus('preparing');
    startFakeProgress(setPrepareProgress, 90, 8, 200);

    try {
      const { data: prepResponse } =
        await evaluationService.prepareEvaluationArtifacts(
          {
            runId: selectedRun.id,
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );
      if (prepResponse.code !== 0) {
        throw new Error(prepResponse.message || 'Failed to prepare artifacts');
      }
      clearProgressInterval();
      setPrepareProgress(100);

      setSubmitDialogStatus('sending');
      startFakeProgress(setSendProgress, 85, 3, 400);

      const { data: submitResponse } =
        await evaluationService.submitEvaluationRun(
          {
            runId: selectedRun.id,
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );

      const sizes = {
        submission_size: submitResponse.data?.submission_size as
          | number
          | undefined,
        code_archive_size: submitResponse.data?.code_archive_size as
          | number
          | undefined,
      };
      setSubmitArtifactSizes(sizes);

      if (submitResponse.code !== 0) {
        throw new Error(submitResponse.message || 'Submission failed');
      }
      clearProgressInterval();
      setSendProgress(100);

      const submissionUuid =
        submitResponse.data?.response?.uuid ||
        submitResponse.data?.response?.id ||
        '';
      setSubmitDialogStatus('success');
      setSubmitMessage(
        submissionUuid
          ? `Submission succeeded (${submissionUuid})`
          : 'Submission succeeded',
      );
      await refetchRuns();
    } catch (error) {
      clearProgressInterval();
      setSubmitDialogStatus('error');
      setSubmitMessage(
        error instanceof Error ? error.message : 'Submission failed',
      );
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

  const [rerunLoading, setRerunLoading] = useState(false);
  const [judgeDialogOpen, setJudgeDialogOpen] = useState(false);
  const [judgeModel, setJudgeModel] = useState('gpt-4.1');
  const [judgePrompt, setJudgePrompt] = useState(
    'You are an impartial grading judge. You will receive a QUESTION, an ANSWER produced by a RAG system, ' +
      'and the RETRIEVED CHUNKS that were provided to the system as context.\n\n' +
      'Your task: determine whether the ANSWER is **correct and grounded** in the RETRIEVED CHUNKS.\n' +
      '- score=1 (true) means the answer is factually correct given the chunks and addresses the question.\n' +
      '- score=0 (false) means the answer is wrong, hallucinated, unsupported by chunks, or fails to address the question.\n\n' +
      'Return ONLY valid JSON (no markdown fences) with this schema for EACH request:\n' +
      '{"score": 1, "explanation": ""}\nor\n{"score": 0, "explanation": "<non-empty reason why the answer failed>"}\n\n' +
      'Rules:\n- explanation MUST be empty string when score=1.\n- explanation MUST be non-empty when score=0.\n' +
      '- Do NOT output anything other than the JSON object.',
  );
  const [judgeRunning, setJudgeRunning] = useState(false);

  const handleRunJudge = async () => {
    if (!selectedRun?.id) return;
    setJudgeRunning(true);
    setJudgeDialogOpen(false);
    try {
      const { data: response } = await evaluationService.runEvaluationLlmJudge(
        {
          runId: selectedRun.id,
          data: { model: judgeModel, prompt: judgePrompt },
          headers: { 'X-Skip-Error-Notification': '1' },
        },
        true,
      );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to start LLM judge');
      }
      message.success('LLM judge started');
      await refetchRuns();
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : 'Failed to start LLM judge',
      );
    } finally {
      setJudgeRunning(false);
    }
  };

  const handleCancelJudge = async () => {
    if (!selectedRun?.id) return;
    try {
      const { data: response } =
        await evaluationService.cancelEvaluationLlmJudge(
          {
            runId: selectedRun.id,
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to cancel LLM judge');
      }
      await refetchRuns();
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : 'Failed to cancel LLM judge',
      );
    }
  };

  const hasFailedOrMissing = useMemo(() => {
    if (!selectedRun || !canDownloadArtifacts) return false;
    return results.some(
      (r) =>
        r.case_status === 'FAILED' || r.case_status === 'MISSING_TELEMETRY',
    );
  }, [selectedRun, canDownloadArtifacts, results]);

  const hasJudgeFailed = useMemo(() => {
    if (!selectedRun || !canDownloadArtifacts) return false;
    return results.some(
      (r) => hasJudgeResult(r.judge_result) && r.judge_result.score === 0,
    );
  }, [selectedRun, canDownloadArtifacts, results]);

  const hasJudgeErrored = useMemo(() => {
    if (!selectedRun || !canDownloadArtifacts) return false;
    return results.some((r) => isJudgeError(r.judge_result));
  }, [selectedRun, canDownloadArtifacts, results]);

  const [rerunJudgeFailedLoading, setRerunJudgeFailedLoading] = useState(false);
  const handleRerunJudgeFailed = async () => {
    if (!selectedRun?.id) return;
    setRerunJudgeFailedLoading(true);
    try {
      const { data: response } = await evaluationService.runEvaluationLlmJudge(
        {
          runId: selectedRun.id,
          data: { model: judgeModel, prompt: judgePrompt, only_failed: true },
          headers: { 'X-Skip-Error-Notification': '1' },
        },
        true,
      );
      if (response.code !== 0) {
        throw new Error(
          response.message || 'Failed to rerun failed LLM judge cases',
        );
      }
      message.success('Re-running failed LLM judge cases');
      await refetchRuns();
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : 'Failed to rerun failed LLM judge cases',
      );
    } finally {
      setRerunJudgeFailedLoading(false);
    }
  };

  const [rerunJudgeErroredLoading, setRerunJudgeErroredLoading] =
    useState(false);
  const handleRerunJudgeErrored = async () => {
    if (!selectedRun?.id) return;
    setRerunJudgeErroredLoading(true);
    try {
      const { data: response } = await evaluationService.runEvaluationLlmJudge(
        {
          runId: selectedRun.id,
          data: { model: judgeModel, prompt: judgePrompt, only_errors: true },
          headers: { 'X-Skip-Error-Notification': '1' },
        },
        true,
      );
      if (response.code !== 0) {
        throw new Error(
          response.message || 'Failed to rerun errored LLM judge cases',
        );
      }
      message.success('Re-running errored LLM judge cases');
      await refetchRuns();
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : 'Failed to rerun errored LLM judge cases',
      );
    } finally {
      setRerunJudgeErroredLoading(false);
    }
  };

  useEffect(() => {
    return () => {
      clearProgressInterval();
    };
  }, []);

  const handleRerunFailed = async () => {
    if (!selectedRun?.id || !selectedTemplate) return;
    setRerunLoading(true);
    try {
      const { data: response } =
        await evaluationService.rerunFailedEvaluationRun(
          {
            runId: selectedRun.id,
            headers: { 'X-Skip-Error-Notification': '1' },
          },
          true,
        );
      if (response.code !== 0) {
        throw new Error(response.message || 'Failed to rerun failed cases');
      }
      await refetchRuns();
      message.success('Rerun started');
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : 'Failed to rerun failed cases',
      );
    } finally {
      setRerunLoading(false);
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
  const summaryMetrics = selectedRun?.metrics_summary;
  const totalEvalCases = summaryMetrics?.total_cases || results.length;
  const requestFailedCount = results.filter(
    (item) => normalizeStatus(item.case_status || '') === 'FAILED',
  ).length;
  const telemetryFailedCount = results.filter(
    (item) => normalizeStatus(item.case_status || '') === 'MISSING_TELEMETRY',
  ).length;
  const judgeFailedCount = results.filter(
    (item) =>
      hasJudgeResult(item.judge_result) && item.judge_result.score === 0,
  ).length;
  const judgeErroredCount = results.filter((item) =>
    isJudgeError(item.judge_result),
  ).length;

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
                        setPendingDeleteTemplateId(template.id);
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
                  {!running &&
                    run.metrics_summary?.sum_execution_time_s != null && (
                      <div className="text-[10px] text-text-secondary mt-0.5">
                        {formatSecondsToHumanReadable(
                          run.metrics_summary.sum_execution_time_s,
                        )}
                      </div>
                    )}
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
                <div className="text-text-secondary">Eval ID</div>
                <code className="break-all">{selectedRun?.id || '-'}</code>
                <div className="text-text-secondary">Run duration</div>
                <div>
                  {summaryMetrics?.run_duration_s != null
                    ? formatSecondsToHumanReadable(
                        summaryMetrics.run_duration_s,
                      )
                    : '-'}
                </div>
                <div className="text-text-secondary">Total eval time</div>
                <div>
                  {summaryMetrics?.sum_execution_time_s != null
                    ? formatSecondsToHumanReadable(
                        summaryMetrics.sum_execution_time_s,
                      )
                    : '-'}
                </div>
                <div className="text-text-secondary">Avg total time</div>
                <div>{formatMs(summaryMetrics?.avg_total_time_ms)}</div>
                <div className="text-text-secondary">Avg TTFT / TPOT</div>
                <div>
                  {formatMs(summaryMetrics?.avg_ttft_ms)}
                  {' / '}
                  {formatMs(summaryMetrics?.avg_tpot_ms)}
                </div>
                <div className="text-text-secondary">Eval statistics</div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span
                        className={`w-2 h-2 rounded-full ${(() => {
                          const s = normalizeStatus(selectedRun?.status || '');
                          const hasFailed = results.some(
                            (r) => r.case_status === 'FAILED',
                          );
                          if (s === 'RUNNING' || s === 'PENDING')
                            return 'bg-state-info';
                          return hasFailed
                            ? 'bg-state-error'
                            : 'bg-state-success';
                        })()}`}
                      />
                      Request:{' '}
                      {(() => {
                        const s = normalizeStatus(selectedRun?.status || '');
                        if (s === 'RUNNING' || s === 'PENDING')
                          return 'Running';
                        return results.some((r) => r.case_status === 'FAILED')
                          ? 'Failed'
                          : 'OK';
                      })()}
                      {' · '}
                      failed{' '}
                      {formatFailedPercent(requestFailedCount, totalEvalCases)}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span
                        className={`w-2 h-2 rounded-full ${(() => {
                          const s = normalizeStatus(selectedRun?.status || '');
                          if (s === 'RUNNING' || s === 'PENDING')
                            return 'bg-state-info';
                          const hasMissing = results.some(
                            (r) => r.case_status === 'MISSING_TELEMETRY',
                          );
                          return hasMissing
                            ? 'bg-state-warning'
                            : 'bg-state-success';
                        })()}`}
                      />
                      Telemetry:{' '}
                      {(() => {
                        const s = normalizeStatus(selectedRun?.status || '');
                        if (s === 'RUNNING' || s === 'PENDING')
                          return 'Running';
                        return results.some(
                          (r) => r.case_status === 'MISSING_TELEMETRY',
                        )
                          ? 'Missing'
                          : 'OK';
                      })()}
                      {' · '}
                      failed{' '}
                      {formatFailedPercent(
                        telemetryFailedCount,
                        totalEvalCases,
                      )}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span
                        className={`w-2 h-2 rounded-full ${(() => {
                          const js = (effectiveJudgeStatus || '').toUpperCase();
                          if (js === 'RUNNING') return 'bg-state-info';
                          if (!js) return 'bg-fill-tertiary';
                          if (
                            judgeFailedCount > 0 ||
                            judgeErroredCount > 0 ||
                            js === 'FAILED'
                          )
                            return 'bg-state-error';
                          return 'bg-state-success';
                        })()}`}
                      />
                      LLM judge:{' '}
                      {(() => {
                        const js = (effectiveJudgeStatus || '').toUpperCase();
                        if (js === 'RUNNING') return 'Running';
                        if (!js) return '-';
                        const hasBadResults =
                          judgeFailedCount > 0 ||
                          judgeErroredCount > 0 ||
                          js === 'FAILED';
                        const parts: string[] = [];
                        if (!hasBadResults) parts.push('OK');
                        parts.push(
                          `failed ${formatFailedPercent(judgeFailedCount, totalEvalCases)}`,
                        );
                        if (judgeErroredCount > 0)
                          parts.push(
                            `errored ${formatFailedPercent(judgeErroredCount, totalEvalCases)}`,
                          );
                        return parts.join(' · ');
                      })()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {selectedRun.is_submitted && (
                      <span className="px-2 py-0.5 rounded-md text-xs bg-state-warning/15 text-state-warning">
                        Submitted
                      </span>
                    )}
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
                </div>
                <div className="text-text-secondary">Re-run</div>
                <div className="flex items-center gap-2 flex-wrap">
                  {hasFailedOrMissing && (
                    <button
                      type="button"
                      onClick={() => void handleRerunFailed()}
                      disabled={rerunLoading}
                      className="h-7 px-2 rounded-md border border-border-default text-xs hover:bg-fill-tertiary inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      <LucideRefreshCw
                        className={`size-3.5 ${rerunLoading ? 'animate-spin' : ''}`}
                      />
                      {rerunLoading ? 'Re-running...' : 'Re-run failed API'}
                    </button>
                  )}
                  {hasJudgeErrored && (
                    <button
                      type="button"
                      onClick={() => void handleRerunJudgeErrored()}
                      disabled={
                        rerunJudgeErroredLoading ||
                        judgeRunning ||
                        (effectiveJudgeStatus || '').toUpperCase() === 'RUNNING'
                      }
                      className="h-7 px-2 rounded-md border border-border-default text-xs hover:bg-fill-tertiary inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      <LucideRefreshCw
                        className={`size-3.5 ${rerunJudgeErroredLoading ? 'animate-spin' : ''}`}
                      />
                      {rerunJudgeErroredLoading
                        ? 'Re-running...'
                        : 'Re-run errored LLM judge'}
                    </button>
                  )}
                  {hasJudgeFailed && (
                    <button
                      type="button"
                      onClick={() => void handleRerunJudgeFailed()}
                      disabled={
                        rerunJudgeFailedLoading ||
                        judgeRunning ||
                        (effectiveJudgeStatus || '').toUpperCase() === 'RUNNING'
                      }
                      className="h-7 px-2 rounded-md border border-border-default text-xs hover:bg-fill-tertiary inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      <LucideRefreshCw
                        className={`size-3.5 ${rerunJudgeFailedLoading ? 'animate-spin' : ''}`}
                      />
                      {rerunJudgeFailedLoading
                        ? 'Re-running...'
                        : 'Re-run failed LLM judge'}
                    </button>
                  )}
                </div>
                <div className="text-text-secondary">Submission</div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => {
                      setSubmitDialogStatus('confirm');
                      setSubmitMessage('');
                      setPrepareProgress(0);
                      setSendProgress(0);
                      setSubmitDialogOpen(true);
                    }}
                    disabled={!selectedRun?.id || !canDownloadArtifacts}
                    className="h-8 px-2 rounded-md border border-border-default text-xs disabled:opacity-50"
                  >
                    Submit
                  </button>
                  {isJudgeRunning ? (
                    <div className="inline-flex items-center gap-2 h-8 px-2 rounded-md border border-border-default text-xs">
                      <LucideScale className="size-3.5 animate-pulse" />
                      <span className="text-text-secondary whitespace-nowrap tabular-nums">
                        {judgeProgressMsg || `${judgeProgressPct}%`}
                      </span>
                      <div className="w-24 h-1.5 rounded-full bg-fill-tertiary overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent-primary transition-all duration-500"
                          style={{
                            width: `${Math.max(4, judgeProgressPct)}%`,
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleCancelJudge()}
                        className="size-5 inline-flex items-center justify-center rounded hover:bg-fill-secondary"
                        title="Cancel judge"
                      >
                        <LucideX className="size-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setJudgeDialogOpen(true)}
                      disabled={
                        !selectedRun?.id ||
                        !canDownloadArtifacts ||
                        judgeRunning
                      }
                      className="h-8 px-2 rounded-md border border-border-default text-xs disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <LucideScale className="size-3.5" />
                      LLM Judge
                    </button>
                  )}
                </div>
              </div>
            </header>

            <ScrollArea className="flex-1 min-h-0">
              <div className="p-4 space-y-3">
                <div className="flex items-center justify-between pb-1 border-b border-border-default">
                  <div className="text-sm text-text-secondary">
                    Showing {filteredResults.length} of {results.length}
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="cursor-pointer"
                        checked={showOnlyJudgeFailed}
                        onChange={(e) =>
                          setShowOnlyJudgeFailed(e.target.checked)
                        }
                      />
                      Only judge failed
                    </label>
                    <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="cursor-pointer"
                        checked={showOnlyJudgeErrors}
                        onChange={(e) =>
                          setShowOnlyJudgeErrors(e.target.checked)
                        }
                      />
                      Only judge errors
                    </label>
                  </div>
                </div>
                {filteredResults.map((result) => {
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
                          {hasJudgeResult(result.judge_result) ? (
                            <span
                              className={`px-2 py-0.5 rounded-md text-xs ${
                                result.judge_result.score === 1
                                  ? 'bg-state-success/10 text-state-success'
                                  : result.judge_result.score === -1
                                    ? 'bg-orange-500/10 text-orange-600'
                                    : 'bg-state-error/10 text-state-error'
                              }`}
                            >
                              Judge:{' '}
                              {result.judge_result.score === 1
                                ? 'Pass'
                                : result.judge_result.score === -1
                                  ? 'Error'
                                  : 'Fail'}
                            </span>
                          ) : (
                            effectiveJudgeStatus && (
                              <span className="px-2 py-0.5 rounded-md text-xs bg-fill-tertiary text-text-secondary">
                                Judge: -
                              </span>
                            )
                          )}
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

                      {active &&
                        hasJudgeResult(result.judge_result) &&
                        (result.judge_result.score === 0 ||
                          result.judge_result.score === -1) &&
                        result.judge_result.explanation && (
                          <div
                            className={`mt-3 p-3 rounded-md ${
                              result.judge_result.score === -1
                                ? 'bg-orange-500/5 border border-orange-500/20'
                                : 'bg-state-error/5 border border-state-error/20'
                            }`}
                          >
                            <div
                              className={`text-xs font-medium mb-1 ${
                                result.judge_result.score === -1
                                  ? 'text-orange-600'
                                  : 'text-state-error'
                              }`}
                            >
                              {result.judge_result.score === -1
                                ? 'Judge error'
                                : 'Judge explanation'}
                            </div>
                            <div
                              className={`text-sm break-words whitespace-pre-wrap select-text ${
                                result.judge_result.score === -1
                                  ? 'text-orange-600/80'
                                  : 'text-state-error/80'
                              }`}
                            >
                              {result.judge_result.explanation}
                            </div>
                          </div>
                        )}

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

                const judgeScore = hasJudgeResult(selectedResult?.judge_result)
                  ? selectedResult!.judge_result.score
                  : null;
                const judgeFailed = judgeScore === 0;
                const judgeErrored = judgeScore === -1;

                return (
                  <div
                    key={`${chunkId}-${idx}`}
                    className={`rounded-lg border p-4 ${
                      judgeErrored
                        ? 'border-orange-400/40 bg-orange-500/5'
                        : judgeFailed
                          ? 'border-state-error/40 bg-state-error/5'
                          : 'border-border-default bg-bg-base'
                    }`}
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

              <div className="pt-2 border-t border-border-default space-y-3">
                <div className="text-sm font-medium">Run settings</div>
                <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={
                      (
                        templateEvalSettings[settingsTemplateId] ?? {
                          parallel: true,
                          maxWorkers: 50,
                        }
                      ).parallel
                    }
                    onChange={(e) => {
                      const prev = templateEvalSettings[settingsTemplateId] ?? {
                        parallel: true,
                        maxWorkers: 50,
                      };
                      setTemplateEvalSettings((s) => ({
                        ...s,
                        [settingsTemplateId]: {
                          ...prev,
                          parallel: e.target.checked,
                        },
                      }));
                    }}
                  />
                  Parallel evaluation
                </label>
                <div className="space-y-1">
                  <div className="text-sm text-text-secondary">
                    Number of parallel evaluations
                  </div>
                  <input
                    type="number"
                    min={2}
                    max={200}
                    value={
                      (
                        templateEvalSettings[settingsTemplateId] ?? {
                          parallel: true,
                          maxWorkers: 50,
                        }
                      ).maxWorkers
                    }
                    disabled={
                      !(
                        templateEvalSettings[settingsTemplateId] ?? {
                          parallel: true,
                          maxWorkers: 50,
                        }
                      ).parallel
                    }
                    onChange={(e) => {
                      const prev = templateEvalSettings[settingsTemplateId] ?? {
                        parallel: true,
                        maxWorkers: 50,
                      };
                      const val = Math.max(
                        2,
                        parseInt(e.target.value, 10) || 2,
                      );
                      setTemplateEvalSettings((s) => ({
                        ...s,
                        [settingsTemplateId]: { ...prev, maxWorkers: val },
                      }));
                    }}
                    className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm disabled:opacity-50"
                  />
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

      <AlertDialog
        open={!!pendingDeleteTemplateId}
        onOpenChange={(open) => !open && setPendingDeleteTemplateId('')}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the eval template. This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingDeleteTemplateId('')}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const templateId = pendingDeleteTemplateId;
                setPendingDeleteTemplateId('');
                if (templateId) {
                  void handleDeleteTemplate(templateId);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={submitDialogOpen}
        onOpenChange={handleSubmitDialogOpenChange}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {submitDialogStatus === 'confirm' && 'Submit run?'}
              {submitDialogStatus === 'preparing' && 'Preparing artifacts'}
              {submitDialogStatus === 'sending' && 'Sending submission'}
              {submitDialogStatus === 'success' && 'Submission succeeded'}
              {submitDialogStatus === 'error' && 'Submission failed'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm text-text-secondary">
            {submitDialogStatus === 'confirm' && (
              <p>
                submission.json and code archive ZIP will be generated and sent
                to the platform API. Continue?
              </p>
            )}
            {(submitDialogStatus === 'preparing' ||
              submitDialogStatus === 'sending') && (
              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium">
                      {prepareProgress >= 100
                        ? 'Artifacts ready'
                        : 'Building submission.json & code archive…'}
                    </span>
                    <span className="text-xs tabular-nums">
                      {Math.round(prepareProgress)}%
                    </span>
                  </div>
                  <Progress value={prepareProgress} className="h-2" />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium">
                      {sendProgress >= 100
                        ? 'Upload complete'
                        : submitDialogStatus === 'sending'
                          ? 'Uploading to platform…'
                          : 'Waiting…'}
                    </span>
                    <span className="text-xs tabular-nums">
                      {Math.round(sendProgress)}%
                    </span>
                  </div>
                  <Progress value={sendProgress} className="h-2" />
                </div>
                {formatBytes(submitArtifactSizes.code_archive_size) && (
                  <div className="text-xs text-text-secondary pt-1">
                    Code archive:{' '}
                    {formatBytes(submitArtifactSizes.code_archive_size)}
                    {formatBytes(submitArtifactSizes.submission_size) &&
                      ` · submission.json: ${formatBytes(submitArtifactSizes.submission_size)}`}
                  </div>
                )}
              </div>
            )}
            {(submitDialogStatus === 'success' ||
              submitDialogStatus === 'error') && (
              <div className="space-y-2">
                <p>
                  {submitDialogStatus === 'success'
                    ? submitMessage
                    : 'Submission failed'}
                </p>
                {submitDialogStatus === 'error' && submitMessage && (
                  <div className="relative group">
                    <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-all bg-bg-base rounded-md border border-border-default max-h-48 overflow-auto select-text">
                      {submitMessage}
                    </pre>
                    <button
                      type="button"
                      className="absolute top-2 right-2 h-6 px-2 rounded text-[10px] border border-border-default bg-bg-card hover:bg-fill-tertiary opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(submitMessage);
                          message.success('Copied to clipboard');
                        } catch {
                          message.error('Failed to copy');
                        }
                      }}
                    >
                      Copy
                    </button>
                  </div>
                )}
                {formatBytes(submitArtifactSizes.code_archive_size) && (
                  <p className="text-xs">
                    Code archive:{' '}
                    {formatBytes(submitArtifactSizes.code_archive_size)}
                    {formatBytes(submitArtifactSizes.submission_size) &&
                      ` · submission.json: ${formatBytes(submitArtifactSizes.submission_size)}`}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            {submitDialogStatus === 'confirm' && (
              <>
                <button
                  type="button"
                  className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
                  onClick={() => setSubmitDialogOpen(false)}
                >
                  No
                </button>
                <button
                  type="button"
                  className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
                  onClick={() => {
                    void handleSubmitRun();
                  }}
                >
                  Yes
                </button>
              </>
            )}
            {(submitDialogStatus === 'preparing' ||
              submitDialogStatus === 'sending') && (
              <button
                type="button"
                className="h-9 px-3 rounded-md border border-border-default text-sm opacity-60 cursor-not-allowed"
                disabled
              >
                {submitDialogStatus === 'preparing' ? 'Preparing…' : 'Sending…'}
              </button>
            )}
            {(submitDialogStatus === 'success' ||
              submitDialogStatus === 'error') && (
              <button
                type="button"
                className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
                onClick={() => setSubmitDialogOpen(false)}
              >
                Close
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <Dialog open={judgeDialogOpen} onOpenChange={setJudgeDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>LLM Judge</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 flex-1 min-h-0 overflow-auto">
            <div className="space-y-2">
              <div className="text-sm text-text-secondary">Judge model</div>
              <input
                value={judgeModel}
                onChange={(e) => setJudgeModel(e.target.value)}
                className="w-full h-9 px-3 rounded-md border border-border-default bg-bg-base text-sm"
                placeholder="gpt-4.1"
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm text-text-secondary">System prompt</div>
              <textarea
                value={judgePrompt}
                onChange={(e) => setJudgePrompt(e.target.value)}
                rows={10}
                className="w-full px-3 py-2 rounded-md border border-border-default bg-bg-base text-sm font-mono resize-y"
              />
            </div>
            <div className="text-xs text-text-secondary">
              The judge will evaluate each question/answer pair against
              retrieved chunks. Results are stored per-case with a boolean score
              and an explanation for failures.
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
              onClick={() => setJudgeDialogOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="h-9 px-3 rounded-md border border-border-default text-sm hover:bg-fill-tertiary"
              onClick={() => void handleRunJudge()}
            >
              Run Judge
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}
