import {
	EMPTY_CONVERSATION_FEED_MUTATION_REVISIONS,
	type ConversationFeedMutationClock,
	type ConversationFeedMutationKind,
} from './conversation-feed-mutations.js';

export class ConversationFeedMutationState {
	#dataRevision = $state(0);
	#lastResponseRevision = $state(0);
	#lastRevisionByKind = $state.raw({ ...EMPTY_CONVERSATION_FEED_MUTATION_REVISIONS });

	get clock(): ConversationFeedMutationClock {
		return {
			dataRevision: this.#dataRevision,
			lastResponseRevision: this.#lastResponseRevision,
			lastRevisionByKind: this.#lastRevisionByKind,
		};
	}

	record(kind: ConversationFeedMutationKind, responseUpdated = false): void {
		const revision = this.#dataRevision + 1;
		this.#dataRevision = revision;
		if (responseUpdated) this.#lastResponseRevision = revision;
		this.#lastRevisionByKind = {
			...this.#lastRevisionByKind,
			[kind]: revision,
		};
	}
}
