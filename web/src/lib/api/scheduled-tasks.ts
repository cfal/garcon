import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import {
	normalizeScheduledTask,
	normalizeScheduledTasksSnapshot,
	type CreateScheduledTaskRequest,
	type ReorderScheduledTasksRequest,
	type RemoveScheduledTaskRequest,
	type ScheduleInTaskRequest,
	type ScheduleInTaskResponse,
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

export async function scheduleChatPrompt(
	request: ScheduleInTaskRequest,
): Promise<ScheduleInTaskResponse> {
	const raw = await apiPost<unknown>('/api/v1/scheduled-tasks/in', request);
	if (!raw || typeof raw !== 'object') throw new Error('Invalid schedule-in response');
	const value = raw as Record<string, unknown>;
	const task = normalizeScheduledTask(value.task);
	const snapshot = normalizeScheduledTasksSnapshot(value.snapshot);
	if (value.success !== true || !task || !snapshot) {
		throw new Error('Invalid schedule-in response');
	}
	if (!snapshot.tasks.some((entry) => entry.id === task.id)) {
		throw new Error('Schedule-in response omitted the created task');
	}
	return { success: true, task, snapshot };
}
