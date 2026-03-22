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
  getEvaluationSubmissionApiKeyStatus: {
    url: api.getEvaluationSubmissionApiKeyStatus,
    method: 'get',
  },
  setEvaluationSubmissionApiKey: {
    url: api.setEvaluationSubmissionApiKey,
    method: 'post',
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
  prepareEvaluationArtifacts: {
    url: (config: { runId: string }) =>
      api.prepareEvaluationArtifacts(config.runId),
    method: 'post',
  },
  submitEvaluationRun: {
    url: (config: { runId: string }) => api.submitEvaluationRun(config.runId),
    method: 'post',
  },
  rerunFailedEvaluationRun: {
    url: (config: { runId: string }) =>
      api.rerunFailedEvaluationRun(config.runId),
    method: 'post',
  },
  runEvaluationLlmJudge: {
    url: (config: { runId: string }) => api.runEvaluationLlmJudge(config.runId),
    method: 'post',
  },
  cancelEvaluationLlmJudge: {
    url: (config: { runId: string }) =>
      api.cancelEvaluationLlmJudge(config.runId),
    method: 'post',
  },
} as const;

const evaluationService = registerNextServer<keyof typeof methods>(methods);

export default evaluationService;
