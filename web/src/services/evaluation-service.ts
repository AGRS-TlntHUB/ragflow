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
  getEvaluationDatasetCases: {
    url: (datasetId: string) => api.getEvaluationDatasetCases(datasetId),
    method: 'get',
  },
} as const;

const evaluationService = registerNextServer<keyof typeof methods>(methods);

export default evaluationService;
