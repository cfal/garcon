import type { WorkflowActivity, WorkflowAttempt, WorkflowAttemptInspection, WorkflowDetail, WorkflowGateInspection, WorkflowOverview,
  WorkflowPlanRevision, WorkflowCatalogEntry } from '$shared/workflows';
import { WORKFLOW_API, WORKFLOW_MUTATION_PATHS, parseWorkflowBootstrap, parseWorkflowMutationResult,
  parseWorkflowOperationResult, workflowReadPath, type WorkflowHttpMutationRequest } from '$shared/workflow-http';
import { apiGet, apiPost, apiPut } from './client.js';

export const workflowApi = {
  async bootstrap(signal?: AbortSignal) { return parseWorkflowBootstrap(await apiGet(`${WORKFLOW_API}/bootstrap`, { signal })); },
  list(after: string | null, signal?: AbortSignal) {
    return apiGet<{ revision: number; workflows: WorkflowCatalogEntry[] }>(workflowReadPath({ kind: 'list', after, limit: 50 }), { signal });
  },
  async detail(id: string, signal?: AbortSignal): Promise<WorkflowDetail> {
    const overview = await apiGet<WorkflowOverview>(workflowReadPath({ kind: 'show', id }), { signal, cache: 'no-store' });
    if (overview.workflow.id !== id) throw new Error('Workflow reply does not match the selected workflow.');
    const plan = async (reference: WorkflowOverview['draft']) => {
      const result = await apiGet<WorkflowPlanRevision>(workflowReadPath({ kind: 'plan', id, planRevision: reference.revision }), { signal, cache: 'no-store' });
      if (result.revision !== reference.revision || result.digest !== reference.digest) throw new Error('Workflow plan reply identity changed.');
      return result;
    };
    const draft = await plan(overview.draft);
    const active = overview.active ? overview.active.revision === draft.revision ? draft : await plan(overview.active) : null;
    return { ...overview, draft, active, artifacts: [], approvals: [] } satisfies WorkflowDetail;
  },
  inspectGate(id: string, gateId: string, signal?: AbortSignal) {
    return apiGet<WorkflowGateInspection>(workflowReadPath({ kind: 'gate', id, gateId }), { signal, cache: 'no-store' });
  },
  async attempts(id: string, before: string | null, signal?: AbortSignal) {
    return (await apiGet<{ attempts: WorkflowAttempt[] }>(workflowReadPath({ kind: 'attempts', id, cursor: before, limit: 50 }), { signal })).attempts;
  },
  async inspectAttempt(id: string, attemptId: string, signal?: AbortSignal) {
    const inspection = await apiGet<WorkflowAttemptInspection>(workflowReadPath({ kind: 'attempt', id, attemptId }), { signal, cache: 'no-store' });
    if (inspection.attempt.workflowId !== id || inspection.attempt.attemptId !== attemptId) throw new Error('Attempt reply identity changed.');
    return inspection;
  },
  async activity(id: string, before = Number.MAX_SAFE_INTEGER, signal?: AbortSignal) {
    return (await apiGet<{ activity: WorkflowActivity[] }>(workflowReadPath({ kind: 'activity', id, before, limit: 50 }), { signal })).activity;
  },
  async mutate(request: WorkflowHttpMutationRequest) {
    const result = parseWorkflowMutationResult(await apiPost(WORKFLOW_MUTATION_PATHS[request.mutation.action], request));
    if (result.operationId !== request.operationId || request.mutation.action !== 'create' && result.workflowId !== request.mutation.workflowId)
      throw new Error('Workflow reply does not match the submitted operation.');
    return result;
  },
  async operation(id: string) { return parseWorkflowOperationResult(await apiGet(`${WORKFLOW_API}/operation?id=${encodeURIComponent(id)}`)); },
  setEnabled(enabled: boolean) { return apiPut<{ enabled: boolean }>(`${WORKFLOW_API}/enabled`, { enabled }); },
};
export type WorkflowApi = typeof workflowApi;
