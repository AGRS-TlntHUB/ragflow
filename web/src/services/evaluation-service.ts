import api from '@/utils/api';
import { registerNextServer } from '@/utils/register-server';

const methods = {
  listEvaluationRuns: {
    url: api.listEvaluationRuns,
    method: 'get',
  },
  getEvaluationRun: {
    url: (runId: string) => api.getEvaluationRun(runId),
    method: 'get',
  },
  createEvaluationDataset: {
    url: api.createEvaluationDataset,
    method: 'post',
  },
  importEvaluationDatasetCases: {
    url: (config: { datasetId: string }) =>
      api.importEvaluationDatasetCases(config.datasetId),
    method: 'post',
  },
  startEvaluationRun: {
    url: api.startEvaluationRun,
    method: 'post',
  },
  getEvaluationDatasetCases: {
    url: (datasetId: string) => api.getEvaluationDatasetCases(datasetId),
    method: 'get',
  },
} as const;

const evaluationService = registerNextServer<keyof typeof methods>(methods);

export default evaluationService;
