import { apiDelete, apiGet, apiPatch, apiPost } from './client.js';
import { isRecord } from '$shared/json';
import {
	isRemoteNodeId,
	parseExecutionNodes,
	type CreateExecutionNodeRequest,
	type ExecutionNodeConnection,
	type ExecutionNodeSnapshot,
	type UpdateExecutionNodeRequest,
} from '$shared/execution-nodes';

function nodesResponse(value: unknown): readonly ExecutionNodeSnapshot[] {
	const nodes = isRecord(value) ? parseExecutionNodes(value.nodes) : null;
	if (!nodes) throw new Error('Invalid execution nodes response');
	return nodes;
}

function connectionResponse(value: unknown): ExecutionNodeConnection {
	if (!isRecord(value) || typeof value.connectionUrl !== 'string'
		|| typeof value.allowInsecureDevelopment !== 'boolean') {
		throw new Error('Invalid execution node connection response');
	}
	return { connectionUrl: value.connectionUrl, allowInsecureDevelopment: value.allowInsecureDevelopment };
}

export async function getExecutionNodes(): Promise<readonly ExecutionNodeSnapshot[]> {
	return nodesResponse(await apiGet<unknown>('/api/v1/execution-nodes'));
}

export async function createExecutionNode(request: CreateExecutionNodeRequest): Promise<ExecutionNodeConnection & { id: string }> {
	const response = await apiPost<unknown>('/api/v1/execution-nodes', request);
	if (!isRecord(response) || !isRemoteNodeId(response.id)) throw new Error('Invalid execution node response');
	return { id: response.id, ...connectionResponse(response) };
}

export async function updateExecutionNode(id: string, request: UpdateExecutionNodeRequest): Promise<readonly ExecutionNodeSnapshot[]> {
	return nodesResponse(await apiPatch<unknown>(`/api/v1/execution-nodes/${encodeURIComponent(id)}`, request));
}

export async function removeExecutionNode(id: string): Promise<readonly ExecutionNodeSnapshot[]> {
	return nodesResponse(await apiDelete<unknown>(`/api/v1/execution-nodes/${encodeURIComponent(id)}`));
}

export async function getExecutionNodeConnection(id: string): Promise<ExecutionNodeConnection> {
	return connectionResponse(await apiGet<unknown>(`/api/v1/execution-nodes/${encodeURIComponent(id)}/connection`));
}
