import { apiDelete, apiGet, apiPatch, apiPost } from './client.js';
import { isRecord } from '$shared/json';
import {
	isRemoteExecutorId,
	parseExecutors,
	type CreateExecutorRequest,
	type ExecutorConnection,
	type ExecutorSnapshot,
	type UpdateExecutorRequest,
} from '$shared/executors';

function executorsResponse(value: unknown): readonly ExecutorSnapshot[] {
	const executors = isRecord(value) ? parseExecutors(value.executors) : null;
	if (!executors) throw new Error('Invalid executors response');
	return executors;
}

function connectionResponse(value: unknown): ExecutorConnection {
	if (!isRecord(value) || typeof value.connectionUrl !== 'string'
		|| typeof value.allowInsecureDevelopment !== 'boolean' || typeof value.allowUnverifiedTls !== 'boolean') {
		throw new Error('Invalid executor connection response');
	}
	return { connectionUrl: value.connectionUrl, allowInsecureDevelopment: value.allowInsecureDevelopment, allowUnverifiedTls: value.allowUnverifiedTls };
}

export async function getExecutors(): Promise<readonly ExecutorSnapshot[]> {
	return executorsResponse(await apiGet<unknown>('/api/v1/executors'));
}

export async function createExecutor(request: CreateExecutorRequest): Promise<ExecutorConnection & { id: string }> {
	const response = await apiPost<unknown>('/api/v1/executors', request);
	if (!isRecord(response) || !isRemoteExecutorId(response.id)) throw new Error('Invalid executor response');
	return { id: response.id, ...connectionResponse(response) };
}

export async function updateExecutor(id: string, request: UpdateExecutorRequest): Promise<readonly ExecutorSnapshot[]> {
	return executorsResponse(await apiPatch<unknown>(`/api/v1/executors/${encodeURIComponent(id)}`, request));
}

export async function removeExecutor(id: string): Promise<readonly ExecutorSnapshot[]> {
	return executorsResponse(await apiDelete<unknown>(`/api/v1/executors/${encodeURIComponent(id)}`));
}

export async function getExecutorConnection(id: string): Promise<ExecutorConnection> {
	return connectionResponse(await apiGet<unknown>(`/api/v1/executors/${encodeURIComponent(id)}/connection`));
}
