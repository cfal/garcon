import type { TranscriptMessage } from '$shared/chat-view';
import type {
	TranscriptReplayPage,
	TranscriptReplayPageReader,
	TranscriptReplayRequest,
} from '$lib/chat/transcript/cached-transcript-resume.js';

// Builds the single page a server returns when it holds rows through `throughOrdinal`.
export function transcriptReplayPage(
	request: TranscriptReplayRequest,
	options: { messages?: TranscriptMessage[]; throughOrdinal?: number; hasMore?: boolean } = {},
): TranscriptReplayPage {
	const throughOrdinal = options.throughOrdinal ?? request.afterOrdinal;
	const lastOrdinal = options.hasMore
		? (options.messages?.at(-1)?.ordinal ?? request.afterOrdinal + 1)
		: throughOrdinal;
	return {
		chatId: request.chatId,
		transcriptViewId: request.transcriptViewId,
		messages: options.messages ?? [],
		firstOrdinal: request.afterOrdinal + 1,
		lastOrdinal,
		nextAfterOrdinal: lastOrdinal,
		throughOrdinal,
		hasMore: options.hasMore ?? false,
		resendCandidates: [],
		transientFeed: {
			serverInstanceId: 'server-instance-test',
			chatId: request.chatId,
			transcriptViewId: request.transcriptViewId,
			transientRevision: 0,
			rows: [],
		},
	};
}

// Answers every catch-up as a server whose head equals the cached cursor.
export const currentTranscriptReplayReader: TranscriptReplayPageReader = (request) =>
	Promise.resolve(transcriptReplayPage(request));

// Lets catch-ups started by panel restores apply their replay page and release live rows.
export function settleTranscriptResumes(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
