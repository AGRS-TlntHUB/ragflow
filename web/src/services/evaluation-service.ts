import api from '@/utils/api';
import { registerNextServer } from '@/utils/register-server';

const methods = {
  listAvailableKbsForEval: {
    url: api.listAvailableKbsForEval,
    method: 'get',
  },
  listAvailableDialogsForEval: {
    url: api.listAvailableDialogsForEval,
    method: 'get',
  },
  listEvaluationTemplateTypes: {
    url: api.listEvaluationTemplateTypes,
    method: 'get',
  },
  listEvaluationTemplates: {
    url: api.listEvaluationTemplates,
    method: 'get',
  },
  createEvaluationTemplate: {
    url: api.createEvaluationTemplate,
    method: 'post',
  },
  deleteEvaluationTemplate: {
    url: (templateId: string) => api.deleteEvaluationTemplate(templateId),
    method: 'delete',
  },
  listEvaluationRuns: {
    url: api.listEvaluationRuns,
    method: 'get',
  },
  getEvaluationRun: {
    url: (runId: string) => api.getEvaluationRun(runId),
    method: 'get',
  },
  getEvaluationRunLogs: {
    url: (runId: string) => api.getEvaluationRunLogs(runId),
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
  downloadEvaluationSubmissionArtifact: {
    url: (config: { runId: string }) =>
      api.downloadEvaluationSubmissionArtifact(config.runId),
    method: 'get',
  },
  downloadEvaluationCodeArchiveArtifact: {
    url: (config: { runId: string }) =>
      api.downloadEvaluationCodeArchiveArtifact(config.runId),
    method: 'get',
  },
} as const;

const evaluationService = registerNextServer<keyof typeof methods>(methods);

export default evaluationService;
