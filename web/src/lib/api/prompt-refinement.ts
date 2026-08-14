import {
	normalizeRefinePromptResponse,
	type RefinePromptRequest,
	type RefinePromptResponse,
} from '$shared/prompt-refinement';
import { apiPost, ApiError, type ApiFetchOptions } from './client.js';

export const PROMPT_REFINEMENT_CLIENT_TIMEOUT_MS = 120_000;

export async function refinePrompt(
	request: RefinePromptRequest,
	options: Pick<ApiFetchOptions, 'signal'> = {},
): Promise<RefinePromptResponse> {
	const response = normalizeRefinePromptResponse(
		await apiPost<unknown>('/api/v1/prompts/refine', request, {
			...options,
			timeoutMs: PROMPT_REFINEMENT_CLIENT_TIMEOUT_MS,
		}),
	);
	if (!response) {
		throw new ApiError(
			502,
			'Prompt refinement returned an invalid response.',
			'PROMPT_REFINEMENT_INVALID_RESPONSE',
		);
	}
	return response;
}
