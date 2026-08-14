import {
	AssistantMessage,
	ErrorMessage,
	PermissionRequestMessage,
	ThinkingMessage,
	isToolUseMessage,
	type ChatMessage,
} from '$shared/chat-types';

export type ConversationFeedMutationKind =
	| 'initial'
	| 'live-append'
	| 'history-earlier'
	| 'history-later'
	| 'history-pruned'
	| 'replacement'
	| 'presentation-structure';

export type ConversationFeedEndBehavior =
	'restore-if-pinned' | 'preserve-reading-position' | 'explicit-navigation';

export interface ConversationFeedMutationClock {
	dataRevision: number;
	lastResponseRevisionByMessageType: Readonly<Record<string, number>>;
	lastRevisionByKind: Readonly<Record<ConversationFeedMutationKind, number>>;
}

export const EMPTY_CONVERSATION_FEED_MUTATION_REVISIONS: Readonly<
	Record<ConversationFeedMutationKind, number>
> = {
	initial: 0,
	'live-append': 0,
	'history-earlier': 0,
	'history-later': 0,
	'history-pruned': 0,
	replacement: 0,
	'presentation-structure': 0,
};

export function conversationFeedMutationKindsSince(
	clock: ConversationFeedMutationClock,
	lastProjectedDataRevision: number,
): ReadonlySet<ConversationFeedMutationKind> {
	return new Set(
		(
			Object.entries(clock.lastRevisionByKind) as Array<[ConversationFeedMutationKind, number]>
		).flatMap(([kind, revision]) => (revision > lastProjectedDataRevision ? [kind] : [])),
	);
}

export function conversationFeedEndBehavior(
	kinds: ReadonlySet<ConversationFeedMutationKind>,
	isLiveWindow: boolean,
): ConversationFeedEndBehavior {
	if (kinds.has('initial') || kinds.has('replacement')) return 'explicit-navigation';
	if (
		isLiveWindow &&
		(kinds.has('live-append') || kinds.has('history-pruned') || kinds.has('presentation-structure'))
	) {
		return 'restore-if-pinned';
	}
	return 'preserve-reading-position';
}

export function responseMessageType(message: ChatMessage): string | null {
	return message instanceof AssistantMessage ||
		message instanceof ThinkingMessage ||
		message instanceof ErrorMessage ||
		message instanceof PermissionRequestMessage ||
		isToolUseMessage(message)
		? message.type
		: null;
}
