// Handles execution-control snapshots and queue dispatch lifecycle events.

import type {
	ChatExecutionControlUpdatedMessage,
} from '$shared/ws-events';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';

export interface QueueContext {
	conversationUi: Pick<ConversationUiPort, 'setExecutionControlFromLiveUpdate'>;
}

export function handleExecutionControlUpdated(
	msg: ChatExecutionControlUpdatedMessage,
	ctx: QueueContext,
) {
	ctx.conversationUi.setExecutionControlFromLiveUpdate(msg.chatId, msg.control);
}
