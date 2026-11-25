import { apiDelete, apiGet, apiPost, apiPut, ApiMutationOutcomeUnknownError, isDefiniteMutationFailure, type ApiFetchOptions } from './client.js';
import * as m from '$lib/paraglide/messages.js';
import {
	parseRenderScheduledPromptResponse,
	type RenderScheduledPromptRequest,
	type RenderScheduledPromptResponse,
} from '$shared/scheduled-prompt-render';
import {
	normalizeCreateScheduledPromptResponse,
	normalizeScheduledPromptsSnapshot,
	type CreateScheduledPromptRequest,
	type CreateScheduledPromptResponse,
	type ReorderScheduledPromptsRequest,
	type RemoveScheduledPromptRequest,
	type SetScheduledPromptEnabledRequest,
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

export async function renderScheduledPrompt(
	request: RenderScheduledPromptRequest,
	options?: ApiFetchOptions,
): Promise<RenderScheduledPromptResponse> {
	const result = parseRenderScheduledPromptResponse(
		await apiPost<unknown>('/api/v1/scheduled-prompts/render', request, options),
	);
	if (!result || result.chatId !== request.chatId) throw new Error('Invalid scheduled prompt rendering response');
	return result;
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
): Promise<CreateScheduledPromptResponse> {
	return createPrompt('/api/v1/scheduled-prompts', request);
}

export async function updateScheduledPrompt(
	request: UpdateScheduledPromptRequest,
): Promise<ScheduledPromptsMutationResponse> {
	return normalizeMutation(await apiPut('/api/v1/scheduled-prompts', request));
}

export async function setScheduledPromptEnabled(
	request: SetScheduledPromptEnabledRequest,
): Promise<ScheduledPromptsMutationResponse> {
	return normalizeMutation(await apiPut('/api/v1/scheduled-prompts/enabled', request));
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
	return createPrompt('/api/v1/scheduled-prompts/in', request);
}

async function createPrompt(url: string, request: CreateScheduledPromptRequest | ScheduleInPromptRequest): Promise<CreateScheduledPromptResponse> {
	try {
		const result = normalizeCreateScheduledPromptResponse(await apiPost<unknown>(url, request));
		if (!result) throw new Error('Invalid scheduled prompt creation response');
		return result;
	} catch (error) {
		// Even a coded 500 can follow a committed schedule whose durability is uncertain.
		if (isDefiniteMutationFailure(error, { clientErrorOnly: 'coded' })) throw error;
		throw new ApiMutationOutcomeUnknownError(m.scheduled_prompts_creation_unconfirmed(), { cause: error });
	}
}
