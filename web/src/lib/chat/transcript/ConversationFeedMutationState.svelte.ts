import {
	EMPTY_CONVERSATION_FEED_MUTATION_REVISIONS,
	type ConversationFeedMutationClock,
	type ConversationFeedMutationKind,
} from './conversation-feed-mutations.js';

export class ConversationFeedMutationState {
	#dataRevision = $state(0);
	#lastResponseRevisionByMessageType = $state.raw<Record<string, number>>({});
	#lastRevisionByKind = $state.raw({ ...EMPTY_CONVERSATION_FEED_MUTATION_REVISIONS });

	get clock(): ConversationFeedMutationClock {
		return {
			dataRevision: this.#dataRevision,
			lastResponseRevisionByMessageType: this.#lastResponseRevisionByMessageType,
			lastRevisionByKind: this.#lastRevisionByKind,
		};
	}

	record(kind: ConversationFeedMutationKind, responseMessageTypes: readonly string[] = []): void {
		const revision = this.#dataRevision + 1;
		this.#dataRevision = revision;
		const uniqueResponseTypes = new Set(responseMessageTypes);
		if (uniqueResponseTypes.size > 0) {
			this.#lastResponseRevisionByMessageType = {
				...this.#lastResponseRevisionByMessageType,
				...Object.fromEntries([...uniqueResponseTypes].map((type) => [type, revision])),
			};
		}
		this.#lastRevisionByKind = {
			...this.#lastRevisionByKind,
			[kind]: revision,
		};
	}
}
