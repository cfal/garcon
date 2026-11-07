import type { ConversationVirtualFeedModel, ConversationVirtualFeedItem } from './conversation-feed-virtual-items.js';

type MemberBoundary = Extract<ConversationVirtualFeedItem, { kind: 'member-boundary' }>;
type Direction = 'earlier' | 'later';

export function nextConversationCoverage(
	model: ConversationVirtualFeedModel,
	range: { startIndex: number; endIndex: number } | null,
	direction: Direction,
	edges: { earlier: boolean; later: boolean },
): MemberBoundary | Direction | null {
	if (range) {
		const target = direction === 'earlier' ? range.startIndex : range.endIndex;
		const boundaries = model.items.flatMap((item, index) => {
			if (item.kind !== 'member-boundary' || item.anchor.kind !== (direction === 'earlier' ? 'before' : 'after')) return [];
			const start = model.items.findIndex(candidate => candidate.kind === 'tool-group' && candidate.descriptor === item.group);
			let end = start + 1;
			while (end < model.items.length) {
				const next = model.items[end];
				if (next.kind === 'tool-group' || next.kind === 'transcript' && next.item.kind === 'message'
					&& (next.item.ordinal ?? Infinity) > item.group.lastMember) break;
				end++;
			}
			return start <= range.endIndex && end > range.startIndex ? [{ item, distance: Math.abs(index - target) }] : [];
		});
		boundaries.sort((a, b) => a.distance - b.distance);
		if (boundaries[0]) return boundaries[0].item;
	}
	if (edges[direction]) return direction;
	const opposite = direction === 'earlier' ? 'later' : 'earlier';
	return edges[opposite] ? opposite : null;
}
