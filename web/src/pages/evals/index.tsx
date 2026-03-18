import { ScrollArea } from '@/components/ui/scroll-area';
import evaluationService from '@/services/evaluation-service';
import { formatDate, formatSecondsToHumanReadable } from '@/utils/date';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type EvaluationRun = {
  id: string;
  dataset_id: string;
  dialog_id: string;
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
};

export default function Evals() {
  const { t } = useTranslation();
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [selectedResultId, setSelectedResultId] = useState<string>('');

  const { data: runsData, isLoading: runsLoading } = useQuery({
    queryKey: ['evaluationRuns'],
    queryFn: async () => {
      const { data: response } = await evaluationService.listEvaluationRuns(
        {
          params: { page: 1, page_size: 500 },
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

  useEffect(() => {
    if (!selectedRunId && runs.length > 0) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, selectedRunId]);

  const selectedRun = useMemo(
    () => runs.find((x) => x.id === selectedRunId),
    [runs, selectedRunId],
  );

  const { data: runDetailData, isLoading: runDetailLoading } = useQuery({
    queryKey: ['evaluationRunDetail', selectedRunId],
    enabled: !!selectedRunId,
    queryFn: async () => {
      const { data: response } =
        await evaluationService.getEvaluationRun(selectedRunId);
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

  const results = runDetailData?.results || [];
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

  const stringifyValue = (value: unknown) => {
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

  return (
    <article className="size-full p-5 flex gap-4 overflow-hidden">
      <aside className="w-64 shrink-0 rounded-xl border border-border-default bg-bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default text-sm font-medium">
          Evals
        </div>
        <ScrollArea className="h-[calc(100%-49px)]">
          <div className="p-2 space-y-1">
            {runs.map((run) => {
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
            {!runsLoading && runs.length === 0 && (
              <div className="px-3 py-2 text-sm text-text-secondary">
                {t('common.noData')}
              </div>
            )}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex-1 min-w-0 flex gap-4">
        <section className="flex-1 rounded-xl border border-border-default bg-bg-card flex flex-col min-h-0 overflow-hidden">
          {selectedRun ? (
            <>
              <header className="px-4 py-3 border-b border-border-default">
                <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-sm">
                  <div className="text-text-secondary">Chat ID</div>
                  <code className="break-all">{selectedRun.dialog_id}</code>
                  <div className="text-text-secondary">Artifact path</div>
                  <code className="break-all">{artifactPath}</code>
                  <div className="text-text-secondary">
                    {t('common.action')}
                  </div>
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
                    return (
                      <button
                        key={result.id}
                        type="button"
                        onClick={() => setSelectedResultId(result.id)}
                        className={`w-full text-left rounded-lg border p-4 transition-colors ${
                          active
                            ? 'border-accent-primary bg-accent-primary-5'
                            : 'border-border-default bg-bg-base hover:bg-fill-tertiary'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-4 mb-2">
                          <div className="font-medium">Question</div>
                          <div className="text-xs text-text-secondary">
                            {formatSecondsToHumanReadable(
                              result.execution_time || 0,
                            )}
                          </div>
                        </div>
                        <div className="text-sm mb-4 break-words">
                          {caseMap.get(result.case_id)?.question || '-'}
                        </div>
                        <div className="font-medium mb-2">Answer</div>
                        <div className="text-sm break-words">
                          {result.generated_answer || '-'}
                        </div>
                      </button>
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
      </section>
    </article>
  );
}
