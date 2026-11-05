import { conversationFeedEndBehavior, conversationFeedMutationKindsSince, type ConversationFeedMutationClock, type ConversationFeedMutationKind } from '$lib/chat/transcript/conversation-feed-mutations.js';
import type { ConversationFeedRenderModel } from '$lib/chat/transcript/conversation-feed-items.js';
import { buildConversationVirtualFeedModel, estimateConversationFeedItemSize, type ConversationVirtualFeedInput, type ConversationVirtualFeedModel } from './conversation-feed-virtual-items.js';

export interface ConversationFeedProjectionInput extends ConversationVirtualFeedInput {
	mutationClock: ConversationFeedMutationClock;
	isLiveWindow: boolean;
}
export interface ConversationVirtualGeometrySnapshot {
	surfaceIdentity: string;
	geometryRevision: number;
	keys: readonly string[];
	estimates: readonly number[];
	measurementReset: 'none' | 'all';
	mutationKinds: ReadonlySet<ConversationFeedMutationKind>;
	endBehavior: ReturnType<typeof conversationFeedEndBehavior>;
}
export interface ConversationFeedProjection {
	renderModel: ConversationFeedRenderModel;
	model: ConversationVirtualFeedModel;
	geometry: ConversationVirtualGeometrySnapshot;
	projectedDataRevision: number;
}

export class ConversationFeedProjectionState {
	#last: ConversationFeedProjection | null = null;
	#revision = 0;
	reconcile(input: ConversationFeedProjectionInput): ConversationFeedProjection {
		const model = buildConversationVirtualFeedModel(input);
		const mutationKinds = new Set(conversationFeedMutationKindsSince(input.mutationClock, this.#last?.projectedDataRevision ?? 0));
		const keys = model.items.map(item => item.key), estimates = model.items.map(estimateConversationFeedItemSize);
		const previous = this.#last?.geometry;
		const changed = !previous || previous.surfaceIdentity !== input.surfaceIdentity || keys.length !== previous.keys.length
			|| keys.some((key, index) => key !== previous.keys[index] || estimates[index] !== previous.estimates[index]);
		if (!previous) mutationKinds.add('initial');
		else if (changed && !mutationKinds.size) mutationKinds.add('presentation-structure');
		let geometry: ConversationVirtualGeometrySnapshot;
		if (changed) {
			geometry = {
				surfaceIdentity: input.surfaceIdentity,
				geometryRevision: ++this.#revision,
				keys,
				estimates,
				measurementReset: 'none',
				mutationKinds,
				endBehavior: conversationFeedEndBehavior(mutationKinds, input.isLiveWindow),
			};
		} else if (mutationKinds.size) {
			geometry = { ...previous, mutationKinds, endBehavior: conversationFeedEndBehavior(mutationKinds, input.isLiveWindow) };
		} else {
			geometry = previous;
		}
		this.#last = { renderModel: input.renderModel, model, geometry, projectedDataRevision: input.mutationClock.dataRevision };
		return this.#last;
	}
	reset(): void { this.#last = null; this.#revision = 0; }
}
