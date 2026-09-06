import {
	parseChatPreambleSelectionTargetResponse,
	parsePreambleSelectionPartialError,
	parsePreambleSelectionPreviewResponse,
	parseUpdateChatPreambleSelectionResponse,
	type ChatPreambleSelectionTargetResponse,
	type PreambleSelectionPreviewRequest,
	type PreambleSelectionPreviewResponse,
	type PreambleSelectionPartialErrorBody,
	type UpdateChatPreambleSelectionRequest,
	type UpdateChatPreambleSelectionResponse,
} from '$shared/chat-preamble-selection-contracts';
import { ApiError, apiGet, apiPost, apiPut } from './client.js';

export type {
	ChatPreambleSelectionTargetResponse,
	PreambleSelectionPreviewRequest,
	PreambleSelectionPreviewResponse,
	UpdateChatPreambleSelectionRequest,
	UpdateChatPreambleSelectionResponse,
};

/** Loads an existing chat's saved selection and its current projection. */
export async function getChatPreambleSelection(
	chatId: string,
	expectedTranscriptViewId?: string,
): Promise<ChatPreambleSelectionTargetResponse> {
	const response = await apiGet<unknown>(`/api/v1/chats/preambles?chatId=${encodeURIComponent(chatId)}`);
	const parsed = parseChatPreambleSelectionTargetResponse(response);
	if (
		!parsed
		|| parsed.chatId !== chatId
		|| (expectedTranscriptViewId !== undefined
			&& parsed.transcriptViewId !== expectedTranscriptViewId)
	) throw new Error('Invalid chat preamble selection response');
	return parsed;
}

export type UpdateChatPreambleSelectionOutcome =
	| { readonly kind: 'committed'; readonly response: UpdateChatPreambleSelectionResponse }
	| { readonly kind: 'partial'; readonly partial: PreambleSelectionPartialErrorBody };

/**
 * Saves an existing chat's selection. A 503 body carrying
 * `selectionCommitted` is surfaced as a partial outcome rather than a thrown
 * error so the editor can adopt the committed selection honestly.
 */
export async function updateChatPreambleSelection(
	request: UpdateChatPreambleSelectionRequest,
): Promise<UpdateChatPreambleSelectionOutcome> {
	let response: unknown;
	try {
		response = await apiPut<unknown>('/api/v1/chats/preambles', request);
	} catch (error) {
		if (error instanceof ApiError) {
			const partial = parsePreambleSelectionPartialError(error.payload);
			if (partial) return { kind: 'partial', partial };
		}
		throw error;
	}
	const parsed = parseUpdateChatPreambleSelectionResponse(response);
	if (
		!parsed
		|| parsed.chatId !== request.chatId
		|| parsed.transcriptViewId !== request.transcriptViewId
		|| parsed.clientRequestId !== request.clientRequestId
		|| parsed.clientMessageId !== request.clientMessageId
	) throw new Error('Invalid chat preamble selection update response');
	return { kind: 'committed', response: parsed };
}

/** Side-effect-free new-chat selection preview; carries no bodies. */
export async function preambleSelectionPreview(
	request: PreambleSelectionPreviewRequest,
): Promise<PreambleSelectionPreviewResponse> {
	const response = await apiPost<unknown>('/api/v1/preambles/selection-preview', request);
	const parsed = parsePreambleSelectionPreviewResponse(response);
	if (
		!parsed
		|| (request.orderedPreambleIds !== undefined
			&& !idsEqual(parsed.orderedPreambleIds, request.orderedPreambleIds))
	) throw new Error('Invalid preamble selection preview response');
	return parsed;
}

function idsEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}
