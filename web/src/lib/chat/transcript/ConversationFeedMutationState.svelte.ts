import {
	EMPTY_CONVERSATION_FEED_MUTATION_REVISIONS,
	type ConversationFeedMutationClock,
	type ConversationFeedMutationKind,
} from './conversation-feed-mutations.js';

export class ConversationFeedMutationState {
	#dataRevision = $state(0);
	#lastRevisionByKind = $state.raw({ ...EMPTY_CONVERSATION_FEED_MUTATION_REVISIONS });

	get clock(): ConversationFeedMutationClock {
		return {
			dataRevision: this.#dataRevision,
			lastRevisionByKind: this.#lastRevisionByKind,
		};
	}

	record(kind: ConversationFeedMutationKind): void {
		const revision = this.#dataRevision + 1;
		this.#dataRevision = revision;
		this.#lastRevisionByKind = {
			...this.#lastRevisionByKind,
			[kind]: revision,
		};
	}
}
