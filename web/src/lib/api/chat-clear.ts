import { parseClearChatResponse, type ClearChatRequest, type ClearChatResponse } from '$shared/chat-clear';
import { apiPost, ApiMutationOutcomeUnknownError, isDefiniteMutationFailure } from './client.js';

export async function clearChat(request: ClearChatRequest): Promise<ClearChatResponse> {
	try {
		const response = parseClearChatResponse(await apiPost<unknown>('/api/v1/chats/clear', request));
		if (response.chatId !== request.chatId || response.transcriptViewId === request.transcriptViewId) {
			throw new TypeError('Clear response does not identify the replacement chat view');
		}
		return response;
	} catch (error) {
		if (isDefiniteMutationFailure(error, { clientErrorOnly: 'envelope' })) throw error;
		throw new ApiMutationOutcomeUnknownError(
			'Clear could not be confirmed. Refresh the chat before trying again. The agent context is unchanged.',
			{ cause: error },
		);
	}
}
