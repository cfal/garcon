import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import {
	normalizeScheduledTasksSnapshot,
	type CreateScheduledTaskRequest,
	type ReorderScheduledTasksRequest,
	type RemoveScheduledTaskRequest,
	type ScheduledTasksMutationResponse,
	type ScheduledTasksSnapshot,
	type UpdateScheduledTaskRequest,
} from '$shared/scheduled-tasks';

function normalizeSnapshot(value: unknown): ScheduledTasksSnapshot {
	const snapshot = normalizeScheduledTasksSnapshot(value);
	if (!snapshot) throw new Error('Invalid scheduled tasks response');
	return snapshot;
}

function normalizeMutation(value: unknown): ScheduledTasksMutationResponse {
	const raw = value as Partial<ScheduledTasksMutationResponse> | null;
	if (!raw || raw.success !== true) throw new Error('Invalid scheduled task mutation response');
	return { success: true, snapshot: normalizeSnapshot(raw.snapshot) };
}

export async function getScheduledTasks(): Promise<ScheduledTasksSnapshot> {
	return normalizeSnapshot(await apiGet<unknown>('/api/v1/scheduled-tasks'));
}

export async function createScheduledTask(
	request: CreateScheduledTaskRequest,
): Promise<ScheduledTasksMutationResponse> {
	return normalizeMutation(await apiPost('/api/v1/scheduled-tasks', request));
}

export async function updateScheduledTask(
	request: UpdateScheduledTaskRequest,
): Promise<ScheduledTasksMutationResponse> {
	return normalizeMutation(await apiPut('/api/v1/scheduled-tasks', request));
}

export async function removeScheduledTask(
	request: RemoveScheduledTaskRequest,
): Promise<ScheduledTasksMutationResponse> {
	return normalizeMutation(await apiDelete('/api/v1/scheduled-tasks', request));
}

export async function reorderScheduledTasks(
	request: ReorderScheduledTasksRequest,
): Promise<ScheduledTasksMutationResponse> {
	return normalizeMutation(await apiPut('/api/v1/scheduled-tasks/reorder', request));
}
