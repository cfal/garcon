import {
	normalizeRefinePromptResponse,
	type RefinePromptRequest,
	type RefinePromptResponse,
} from '$shared/prompt-refinement';
import { hasSameSnippetTemplateTokenSignature } from '$shared/snippets';
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
		request.target,
	);
	if (!response) {
		throw new ApiError(
			502,
			'Prompt refinement returned an invalid response.',
			'PROMPT_REFINEMENT_INVALID_RESPONSE',
		);
	}
	if (
		request.target === 'snippet-template' &&
		!hasSameSnippetTemplateTokenSignature(request.draft, response.refinedPrompt)
	) {
		throw new ApiError(
			502,
			'Prompt refinement changed the snippet template token structure.',
			'PROMPT_REFINEMENT_TOKEN_SIGNATURE_CHANGED',
		);
	}
	return response;
}
