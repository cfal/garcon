import { ApiError } from '$lib/api/client.js';
import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';
import { errorMessage } from '$lib/utils/error-message.js';
import * as m from '$lib/paraglide/messages.js';

export function queuedInputMoveError(error: unknown): string {
	if (error instanceof CommandOutcomeUnknownError) return m.chat_queue_move_unknown();
	if (error instanceof ApiError) {
		if (
			error.errorCode === 'QUEUE_ENTRY_REORDER_CONFLICT' ||
			error.errorCode === 'QUEUE_ENTRY_REVISION_CONFLICT'
		)
			return m.chat_queue_move_conflict();
		if (
			error.errorCode === 'QUEUE_ENTRY_ALREADY_SENT' ||
			error.errorCode === 'QUEUE_ENTRY_NOT_FOUND'
		)
			return m.chat_queue_move_departed();
	}
	return errorMessage(error);
}
