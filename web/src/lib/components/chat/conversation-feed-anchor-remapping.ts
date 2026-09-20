import type { VirtualMutationAnchor } from '$lib/virt/virtual-list-types.js';
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
	const rowIds = previousItem?.kind === 'tool-group'
		? previousItem.members.map((member) => member.item.id)
		: [previous.representativeRowIdByKey.get(key)];
	for (const rowId of rowIds) {
		if (rowId === undefined) continue;
		const index = next.indexByRowId.get(rowId);
		if (index === undefined) continue;
		const nextKey = next.items[index]?.key;
		if (nextKey) return nextKey;
	}
	return undefined;
}

export function remapConversationAnchor(
	anchor: ConversationVirtualAnchor | null,
	previous: ConversationVirtualFeedModel,
	next: ConversationVirtualFeedModel,
): RemappedConversationAnchor | null {
	if (!anchor) return null;
	for (const candidate of [anchor.key, ...anchor.fallbackKeys]) {
		const nextKey = replacementKey(candidate, previous, next);
		if (!nextKey) continue;
		const nextIndex = next.indexByKey.get(nextKey);
		const fallbackKeys = nextIndex === undefined
			? []
			: conversationAnchorFallbackKeys(
					next.items.map((item) => item.key),
					nextIndex,
				);
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
