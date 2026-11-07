import { parseWorkflowMutationRequest, workflowId, workflowInteger, workflowInvalid, workflowRecord } from './workflow-validation.js';
import { WORKFLOW_LIMITS, type WorkflowMutation, type WorkflowMutationRequest, type WorkflowMutationResult, type WorkflowOperationResult } from './workflows.js';

export const WORKFLOW_API = '/api/v1/workflows';
export const WORKFLOW_REQUEST_BYTES = WORKFLOW_LIMITS.planBytes + 16 * 1024;
export interface WorkflowBootstrap { readonly storeId: string; readonly revision: number; readonly enabled: boolean }
export interface WorkflowHttpMutationRequest extends WorkflowMutationRequest { readonly expectedStoreId: string }
export type WorkflowReadQuery =
  | { readonly kind: 'list'; readonly after: string | null; readonly limit: number }
  | { readonly kind: 'show'; readonly id: string }
  | { readonly kind: 'attempt'; readonly id: string; readonly attemptId: string }
  | { readonly kind: 'plan'; readonly id: string; readonly planRevision: number }
  | { readonly kind: 'gate'; readonly id: string; readonly gateId: string }
  | { readonly kind: 'diagram'; readonly id: string; readonly planRevision: number }
  | { readonly kind: 'attempts' | 'artifacts'; readonly id: string; readonly cursor: string | null; readonly limit: number }
  | { readonly kind: 'activity'; readonly id: string; readonly before: number; readonly limit: number };

export function workflowReadPath(query: WorkflowReadQuery): string {
  const params = new URLSearchParams();
  if ('id' in query) params.set('id', workflowId(query.id));
  if (query.kind === 'attempt') params.set('attemptId', workflowId(query.attemptId));
  if (query.kind === 'gate') params.set('gateId', workflowId(query.gateId));
  if ('limit' in query) params.set('limit', String(workflowInteger(query.limit, 1, WORKFLOW_LIMITS.pageSize)));
  if ('cursor' in query && query.cursor) params.set(query.kind === 'artifacts' ? 'after' : 'before', workflowId(query.cursor));
  if (query.kind === 'list' && query.after) params.set('after', workflowId(query.after));
  if (query.kind === 'activity') params.set('before', String(workflowInteger(query.before, 1)));
  if (query.kind === 'diagram' || query.kind === 'plan') params.set('planRevision', String(workflowInteger(query.planRevision, 1)));
  return `${WORKFLOW_API}${query.kind === 'list' ? '' : query.kind === 'show' ? '/detail' : `/${query.kind}`}?${params}`;
}

export function parseWorkflowBootstrap(value: unknown): WorkflowBootstrap {
  const raw = workflowRecord(value, ['storeId', 'revision', 'enabled']);
  if (typeof raw.enabled !== 'boolean') return workflowInvalid('Invalid workflow availability.');
  return { storeId: workflowId(raw.storeId), revision: workflowInteger(raw.revision), enabled: raw.enabled };
}

export function parseWorkflowMutationResult(value: unknown): WorkflowMutationResult {
  const raw = workflowRecord(value, ['operationId', 'workflowId', 'revision', 'collectionRevision']);
  return { operationId: workflowId(raw.operationId), workflowId: workflowId(raw.workflowId),
    revision: workflowInteger(raw.revision, 1), collectionRevision: workflowInteger(raw.collectionRevision, 1) };
}

export function parseWorkflowOperationResult(value: unknown): WorkflowOperationResult {
  const raw = workflowRecord(value, ['kind', 'result']);
  if (raw.kind === 'completed') return { kind: raw.kind, result: parseWorkflowMutationResult(raw.result) };
  if ((raw.kind === 'not-found' || raw.kind === 'result-expired') && raw.result === undefined) return { kind: raw.kind };
  return workflowInvalid('Invalid workflow operation result.');
}
export const WORKFLOW_MUTATION_PATHS = {
  create: WORKFLOW_API,
  plan: `${WORKFLOW_API}/plan`, activate: `${WORKFLOW_API}/activate`,
  pause: `${WORKFLOW_API}/pause`, stop: `${WORKFLOW_API}/stop`, cancel: `${WORKFLOW_API}/cancel`,
  resume: `${WORKFLOW_API}/resume`, retry: `${WORKFLOW_API}/retry`, approve: `${WORKFLOW_API}/approve`,
  resolve: `${WORKFLOW_API}/resolve`, archive: `${WORKFLOW_API}/archive`,
  'clear-hold': `${WORKFLOW_API}/clear-hold`,
  'recheck-publication': `${WORKFLOW_API}/recheck-publication`,
  cleanup: `${WORKFLOW_API}/cleanup`,
} as const satisfies Record<WorkflowMutation['action'], string>;

export function parseWorkflowHttpMutation(value: unknown, action: WorkflowMutation['action']): WorkflowHttpMutationRequest {
  const raw = workflowRecord(value, ['expectedStoreId', 'operationId', 'mutation']);
  const request = parseWorkflowMutationRequest({ operationId: raw.operationId, mutation: raw.mutation });
  if (request.mutation.action !== action) return workflowInvalid('Workflow action does not match this endpoint.');
  return { ...request, expectedStoreId: workflowId(raw.expectedStoreId) };
}

export function workflowQuery(url: URL, allowed: readonly string[]): URLSearchParams {
  const query = url.searchParams;
  for (const key of query.keys()) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) workflowInvalid('Unexpected or repeated workflow query parameter.');
  }
  return query;
}

export function workflowQueryInteger(query: URLSearchParams, key: string, fallback?: number): number {
  const value = query.get(key);
  if (value === null && fallback !== undefined) return fallback;
  if (value === null || !/^[1-9][0-9]*$/u.test(value)) return workflowInvalid(`Invalid ${key}.`);
  return workflowInteger(Number(value), 1, key === 'limit' ? WORKFLOW_LIMITS.pageSize : Number.MAX_SAFE_INTEGER);
}

export function workflowQueryId(query: URLSearchParams): string { return workflowId(query.get('id')); }
