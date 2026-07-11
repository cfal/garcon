import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import {
	normalizeScheduledPrompt,
	normalizeScheduledPromptsSnapshot,
	type CreateScheduledPromptRequest,
	type ReorderScheduledPromptsRequest,
	type RemoveScheduledPromptRequest,
	type ScheduleInPromptRequest,
	type ScheduleInPromptResponse,
	type ScheduledPromptsMutationResponse,
	type ScheduledPromptsSnapshot,
	type UpdateScheduledPromptRequest,
} from '$shared/scheduled-prompts';

function normalizeSnapshot(value: unknown): ScheduledPromptsSnapshot {
	const snapshot = normalizeScheduledPromptsSnapshot(value);
	if (!snapshot) throw new Error('Invalid scheduled prompts response');
	return snapshot;
}

function normalizeMutation(value: unknown): ScheduledPromptsMutationResponse {
	const raw = value as Partial<ScheduledPromptsMutationResponse> | null;
	if (!raw || raw.success !== true) throw new Error('Invalid scheduled prompt mutation response');
	return { success: true, snapshot: normalizeSnapshot(raw.snapshot) };
}

export async function getScheduledPrompts(): Promise<ScheduledPromptsSnapshot> {
	return normalizeSnapshot(await apiGet<unknown>('/api/v1/scheduled-prompts'));
}

export async function createScheduledPrompt(
	request: CreateScheduledPromptRequest,
): Promise<ScheduledPromptsMutationResponse> {
	return normalizeMutation(await apiPost('/api/v1/scheduled-prompts', request));
}

export async function updateScheduledPrompt(
	request: UpdateScheduledPromptRequest,
): Promise<ScheduledPromptsMutationResponse> {
	return normalizeMutation(await apiPut('/api/v1/scheduled-prompts', request));
}

export async function removeScheduledPrompt(
	request: RemoveScheduledPromptRequest,
): Promise<ScheduledPromptsMutationResponse> {
	return normalizeMutation(await apiDelete('/api/v1/scheduled-prompts', request));
}

export async function reorderScheduledPrompts(
	request: ReorderScheduledPromptsRequest,
): Promise<ScheduledPromptsMutationResponse> {
	return normalizeMutation(await apiPut('/api/v1/scheduled-prompts/reorder', request));
}

export async function scheduleChatPrompt(
	request: ScheduleInPromptRequest,
): Promise<ScheduleInPromptResponse> {
	const raw = await apiPost<unknown>('/api/v1/scheduled-prompts/in', request);
	if (!raw || typeof raw !== 'object') throw new Error('Invalid schedule-in response');
	const value = raw as Record<string, unknown>;
	const scheduledPrompt = normalizeScheduledPrompt(value.scheduledPrompt);
	const snapshot = normalizeScheduledPromptsSnapshot(value.snapshot);
	if (value.success !== true || !scheduledPrompt || !snapshot) {
		throw new Error('Invalid schedule-in response');
	}
	if (!snapshot.prompts.some((entry) => entry.id === scheduledPrompt.id)) {
		throw new Error('Schedule-in response omitted the created prompt');
	}
	return { success: true, scheduledPrompt, snapshot };
}
