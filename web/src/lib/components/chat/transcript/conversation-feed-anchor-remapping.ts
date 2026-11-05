import type { VirtualMutationAnchor } from '$lib/virt/virtual-list-types.js';
import type { ConversationViewportTarget } from '$lib/chat/transcript/conversation-viewport-port.js';
import { groupContainingRow, type ConversationVirtualFeedModel, type ConversationVirtualTarget } from './conversation-feed-virtual-items.js';
import {
	conversationAnchorFallbackKeys,
	type ConversationVirtualAnchor,
} from './conversation-feed-virtual-runtime.js';

export interface RemappedConversationAnchor {
	readonly oldKey: string;
	readonly anchor: ConversationVirtualAnchor;
}

export function resolveConversationTarget(
	target: ConversationViewportTarget,
	model: ConversationVirtualFeedModel,
): ConversationVirtualTarget | undefined {
	if (target.kind === 'dom-anchor') return model.targetByDomAnchorId.get(target.id);
	const group = groupContainingRow(model, target.id);
	const index = model.indexByRowId.get(target.id) ?? (group ? model.indexByKey.get(group.key) : undefined);
	if (index === undefined) return undefined;
	const item = model.items[index];
	const innerRowId = target.kind === 'presentation-row' && item?.kind === 'tool-group'
		? item.anchorId : target.id;
	return { index, innerRowId };
}

function replacementKey(
	key: string,
	previous: ConversationVirtualFeedModel,
	next: ConversationVirtualFeedModel,
): string | undefined {
	if (next.indexByKey.has(key)) return key;
	const rowId = previous.representativeRowIdByKey.get(key);
	if (rowId !== undefined) {
		const group = groupContainingRow(next, rowId);
		const index = next.indexByRowId.get(rowId) ?? (group ? next.indexByKey.get(group.key) : undefined);
		const nextKey = index === undefined ? undefined : next.items[index]?.key;
		if (nextKey) return nextKey;
	}
	const prior = previous.items[previous.indexByKey.get(key) ?? -1];
	if (prior?.kind === 'tool-group') {
		const group = next.items.find(item => item.kind === 'tool-group'
			&& item.descriptor.firstMember <= prior.descriptor.lastMember
			&& item.descriptor.lastMember >= prior.descriptor.firstMember);
		if (group) return group.key;
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
