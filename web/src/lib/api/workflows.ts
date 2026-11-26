import { workflowPaths } from '$shared/workflow-http';
import type {
	WorkflowActiveChat, WorkflowAddItemRequest, WorkflowAddStepRequest, WorkflowArchiveRequest, WorkflowDecisionRequest,
	WorkflowDefinitionSummary, WorkflowDeleteDefinitionRequest, WorkflowPage, WorkflowPageRequest, WorkflowPublishRequest,
	WorkflowRetryRequest, WorkflowRevision, WorkflowRevisionSummary, WorkflowRunDetail, WorkflowRunSummary,
	WorkflowStartRequest, WorkflowStopRequest, WorkflowTestRequest,
} from '$shared/workflow-runs';
import { apiDelete, apiGet, apiPost } from './client.js';

const changes = new EventTarget();
export function subscribeWorkflowChanges(listener: () => void): () => void {
	changes.addEventListener('change', listener);
	return () => changes.removeEventListener('change', listener);
}

type ReadOptions = { signal?: AbortSignal };
type ListOptions = ReadOptions & WorkflowPageRequest;

async function list<T>(path: string, options: ListOptions = {}): Promise<WorkflowPage<T>> {
	const query = new URLSearchParams();
	if (options.cursor) query.set('cursor', options.cursor);
	if (options.limit !== undefined) query.set('limit', String(options.limit));
	const result = await apiGet<WorkflowPage<T>>(`${path}?${query}`, { signal: options.signal });
	if (!Array.isArray(result?.items) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) {
		throw new Error('Invalid workflow list response.');
	}
	return result;
}
export const listWorkflowDefinitionsPage = (options?: ListOptions) => list<WorkflowDefinitionSummary>(workflowPaths.definitions, options);
export const listWorkflowRunsPage = (options?: ListOptions) => list<WorkflowRunSummary>(workflowPaths.runs, options);
export const listActiveWorkflowChatsPage = (options?: ListOptions) => list<WorkflowActiveChat>(workflowPaths.activeChats, options);

export async function getWorkflowRevision(definitionId: string, revision?: number, options?: ReadOptions): Promise<WorkflowRevision> {
	const query = new URLSearchParams({ definitionId });
	if (revision !== undefined) query.set('revision', String(revision));
	const result = await apiGet<WorkflowRevision>(`${workflowPaths.revision}?${query}`, options);
	if (result?.definitionId !== definitionId || (revision !== undefined && result.revision !== revision)) {
		throw new Error('Invalid workflow revision response.');
	}
	return result;
}
export async function listWorkflowRevisions(
	definitionId: string,
	options?: ReadOptions,
): Promise<{ readonly items: readonly WorkflowRevisionSummary[] }> {
	const result = await apiGet<{ items: readonly WorkflowRevisionSummary[] }>(
		`${workflowPaths.revisions}?${new URLSearchParams({ definitionId })}`,
		options,
	);
	if (!Array.isArray(result?.items)) throw new Error('Invalid workflow revisions response.');
	return result;
}
export async function getWorkflowRun(runId: string, options?: ReadOptions): Promise<WorkflowRunDetail> {
	const result = await apiGet<WorkflowRunDetail>(`${workflowPaths.run}?${new URLSearchParams({ runId })}`, options);
	if (result?.id !== runId || !Array.isArray(result.steps)) throw new Error('Invalid workflow run response.');
	return result;
}

async function mutation<T>(path: string, request: unknown): Promise<T> {
	const result = await apiPost<T>(path, request);
	changes.dispatchEvent(new Event('change'));
	return result;
}
export const publishWorkflowDefinition = (request: WorkflowPublishRequest) => mutation<WorkflowRevision>(workflowPaths.definitions, request);
export async function deleteWorkflowDefinition(
	request: WorkflowDeleteDefinitionRequest,
): Promise<{ readonly deleted: true; readonly definitionId: string }> {
	const result = await apiDelete<{ deleted: true; definitionId: string }>(workflowPaths.definitions, request);
	changes.dispatchEvent(new Event('change'));
	return result;
}
export const startWorkflowRun = (request: WorkflowStartRequest) => mutation<WorkflowRunDetail>(workflowPaths.runs, request);
export const testWorkflowDraft = (request: WorkflowTestRequest) => mutation<WorkflowRunDetail>(workflowPaths.testDraft, request);
export const decideWorkflow = (request: WorkflowDecisionRequest) => mutation<WorkflowRunDetail>(workflowPaths.decide, request);
export const addWorkflowItem = (request: WorkflowAddItemRequest) => mutation<WorkflowRunDetail>(workflowPaths.addItem, request);
export const addWorkflowStep = (request: WorkflowAddStepRequest) => mutation<WorkflowRunDetail>(workflowPaths.addStep, request);
export const retryWorkflowStep = (request: WorkflowRetryRequest) => mutation<WorkflowRunDetail>(workflowPaths.retry, request);
export const stopWorkflowRun = (request: WorkflowStopRequest) => mutation<WorkflowRunDetail>(workflowPaths.stop, request);
export const archiveWorkflowRun = (request: WorkflowArchiveRequest) => mutation<WorkflowRunDetail>(workflowPaths.archive, request);
