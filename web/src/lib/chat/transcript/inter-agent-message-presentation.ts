import type {
	InterAgentMessageFailureReason,
	InterAgentMessageResult,
} from '$shared/transcript-notice-details';

function legacyFailureReasonContent(reason: InterAgentMessageFailureReason): string {
	switch (reason) {
		case 'disabled':
			return 'agent messaging is disabled';
		case 'self-send':
			return 'cannot send to the source chat';
		case 'target-not-found':
			return 'chat not found';
		case 'target-unavailable':
			return 'chat unavailable';
		case 'queue-full':
			return 'control input queue full';
		case 'provider-rejected':
			return 'target agent rejected the message';
		case 'delivery-unknown':
			return 'delivery may have occurred; no retry was queued';
		case 'server-shutting-down':
			return 'server shutting down';
		case 'delivery-failed':
			return 'delivery failed';
	}
}

function legacyOutcomeLine(result: InterAgentMessageResult): string {
	switch (result.status) {
		case 'delivered':
			return `Delivered: ${result.chatId}`;
		case 'queued':
			return `Queued: ${result.chatId} (pending delivery is not retained across server restart)`;
		case 'failed':
			return `Failed: ${result.chatId} (${legacyFailureReasonContent(result.reason)})`;
	}
}

export function stripLegacyInterAgentOutcomePrefix(
	content: string,
	results: readonly InterAgentMessageResult[],
): string {
	if (results.length === 0) return content;
	const prefix = `${results.map(legacyOutcomeLine).join('\n')}\n\n`;
	return content.startsWith(prefix) ? content.slice(prefix.length) : content;
}
