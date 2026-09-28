import * as m from '$lib/paraglide/messages.js';
import { forkChat, type ForkChatParams } from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import type { ForkChatResponse } from '$shared/chat-command-contracts';
import { errorDetail } from '$lib/chat/conversation/conversation-submission-helpers.js';
import {
	CommandOutcomeUnknownError,
	submitReplayedCommand,
} from '$lib/chat/conversation/idempotent-command.js';

/**
 * Requests a fork into the caller's target chat ID. A lost reply is retried with the same ID,
 * which the server answers with the fork it already created. The server refuses a fork point
 * it cannot branch natively, so the user decides whether to take a handoff fork instead;
 * declining resolves null, which is an answer rather than a failure.
 */
export async function requestChatFork(
	params: ForkChatParams,
	confirmHandoffFork: (() => Promise<boolean>) | undefined,
): Promise<ForkChatResponse | null> {
	try {
		return await submitReplayedCommand(() => forkChat(params));
	} catch (error) {
		if (!isHandoffForkConfirmationError(error) || !confirmHandoffFork) throw error;
		if (!(await confirmHandoffFork())) return null;
		return submitReplayedCommand(() => forkChat({ ...params, allowHandoffFork: true }));
	}
}

export function isHandoffForkConfirmationError(error: unknown): error is ApiError {
	return error instanceof ApiError && error.errorCode === 'TRANSCRIPT_NOT_YET_PERSISTED';
}

export function forkFailureNotice(error: unknown): string {
	return error instanceof CommandOutcomeUnknownError
		? m.chat_notice_fork_outcome_unconfirmed()
		: m.chat_notice_failed_fork_chat({ detail: errorDetail(error) });
}
