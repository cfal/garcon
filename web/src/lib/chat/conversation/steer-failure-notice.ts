import { ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';
import { errorDetail } from './conversation-submission-helpers.js';
import { CommandOutcomeUnknownError } from './idempotent-command.js';

export function steerFailureNotice(error: unknown): string {
	const failure = error instanceof CommandOutcomeUnknownError ? error.cause : error;
	if (failure instanceof ApiError) {
		switch (failure.errorCode) {
			case 'OPERATION_UNSUPPORTED':
				return m.chat_notice_steer_unsupported();
			case 'STEER_TURN_UNAVAILABLE':
				return m.chat_notice_steer_turn_unavailable();
			case 'STEER_TURN_CHANGED':
				return m.chat_notice_steer_turn_changed();
			case 'STEER_TURN_NOT_STEERABLE':
				return m.chat_notice_steer_turn_not_steerable();
			case 'STEER_CAPACITY_EXHAUSTED':
				return m.chat_notice_steer_capacity_exhausted();
			case 'STEER_PROVIDER_REJECTED':
				return m.chat_notice_steer_provider_rejected();
			case 'STEER_NOT_DELIVERED':
				return m.chat_notice_steer_not_delivered();
			case 'QUEUE_ENTRY_NOT_FOUND':
			case 'QUEUE_ENTRY_ALREADY_SENT':
			case 'QUEUE_ENTRY_IN_FLIGHT':
			case 'QUEUE_ENTRY_REVISION_CONFLICT':
			case 'QUEUE_ENTRY_REORDER_CONFLICT':
				return m.chat_notice_queue_steer_changed();
			case 'QUEUE_STEER_FINALIZATION_FAILED':
				return m.chat_notice_queue_steer_finalization_failed();
			case 'QUEUE_STEER_RECOVERY_FAILED':
				return m.chat_notice_queue_steer_recovery_failed();
		}
	}
	return m.chat_notice_failed_steer({ detail: errorDetail(failure) });
}
