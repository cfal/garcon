import type { VirtualMutationAnchor } from '$lib/virt/virtual-list-types.js';
import type { ConversationFeedProjection } from './ConversationFeedProjectionState.svelte.js';
import type { ConversationVirtualFeedModel } from './conversation-feed-virtual-items.js';
import {
	conversationAnchorFallbackKeys,
	type ConversationVirtualAnchor,
} from './conversation-feed-virtual-runtime.js';

export interface RemappedConversationAnchor {
	readonly oldKey: string;
	readonly anchor: ConversationVirtualAnchor;
}

function replacementKey(
	key: string,
	previous: ConversationVirtualFeedModel,
	next: ConversationVirtualFeedModel,
): string | undefined {
	if (next.indexByKey.has(key)) return key;
	const previousIndex = previous.indexByKey.get(key);
	const previousItem = previousIndex === undefined ? undefined : previous.items[previousIndex];
	if (previousItem?.kind !== 'tool-group' && previousItem?.kind !== 'transcript') return;
	const members = previousItem.kind === 'tool-group' ? previousItem.members : [previousItem];
	for (const member of members) {
		const index = next.indexByRowId.get(member.item.id);
		if (index === undefined) continue;
		const nextKey = next.items[index]?.key;
		if (nextKey) return nextKey;
	}
	return undefined;
}

export function remapConversationAnchor(
	anchor: ConversationVirtualAnchor | null,
	previous: ConversationVirtualFeedModel,
	next: ConversationFeedProjection,
): RemappedConversationAnchor | null {
	if (!anchor) return null;
	for (const candidate of [anchor.key, ...anchor.fallbackKeys]) {
		const nextKey = replacementKey(candidate, previous, next.model);
		if (!nextKey) continue;
		const nextIndex = next.model.indexByKey.get(nextKey);
		const fallbackKeys = nextIndex === undefined
			? []
			: conversationAnchorFallbackKeys(next.geometry.keys, nextIndex);
		let viewportOffset = 0;
		if (candidate === anchor.key) {
			viewportOffset = nextKey === candidate
				? anchor.viewportOffset
				: Math.max(0, anchor.viewportOffset);
		}
		return {
			oldKey: candidate,
			anchor: { key: nextKey, viewportOffset, fallbackKeys },
		};
	}
	return null;
}

interface ConversationProjectionMutationAnchorInput {
	readonly selected: RemappedConversationAnchor | null;
	readonly restoreEnd: boolean;
	readonly explicitNavigation: boolean;
	readonly targetScrollActive: boolean;
}

export function conversationProjectionMutationAnchor(
	input: ConversationProjectionMutationAnchorInput,
): VirtualMutationAnchor {
	if (input.targetScrollActive || input.explicitNavigation) return { kind: 'none' };
	if (input.restoreEnd) return { kind: 'end' };
	if (!input.selected) return { kind: 'none' };
	if (input.selected.oldKey === input.selected.anchor.key) {
		return { kind: 'item', key: input.selected.oldKey };
	}
	return {
		kind: 'item-remap',
		oldKey: input.selected.oldKey,
		newKey: input.selected.anchor.key,
	};
}
