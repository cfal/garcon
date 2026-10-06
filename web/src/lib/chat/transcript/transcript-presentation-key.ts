import { UserMessage, type ChatMessage } from '$shared/chat-types';

export function transcriptPresentationKey(row:
	| { readonly kind: 'message'; readonly id: string; readonly message: ChatMessage }
	| { readonly kind: 'local-notice'; readonly id: string },
): string {
	if (row.kind === 'message' && row.message instanceof UserMessage && row.message.metadata?.clientMessageId) {
		return JSON.stringify(['user-input', row.message.metadata.clientMessageId]);
	}
	return row.id;
}
