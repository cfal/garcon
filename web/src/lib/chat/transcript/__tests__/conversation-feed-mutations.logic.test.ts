import { describe, expect, it } from 'vitest';
import {
	conversationFeedEndBehavior,
	conversationFeedMutationKindsSince,
	type ConversationFeedMutationClock,
} from '../conversation-feed-mutations.js';

function clock(
	lastRevisionByKind: ConversationFeedMutationClock['lastRevisionByKind'],
): ConversationFeedMutationClock {
	return {
		dataRevision: Math.max(...Object.values(lastRevisionByKind)),
		lastResponseRevisionByMessageType: {},
		lastRevisionByKind,
	};
}

describe('conversation feed mutations', () => {
	it('collects every coalesced mutation kind since the acknowledged revision', () => {
		const kinds = conversationFeedMutationKindsSince(
			clock({
				initial: 0,
				'live-append': 7,
				'history-earlier': 6,
				'history-later': 0,
				'history-pruned': 0,
				replacement: 0,
				'presentation-structure': 8,
			}),
			5,
		);

		expect([...kinds].sort()).toEqual(['history-earlier', 'live-append', 'presentation-structure']);
	});

	it('lets replacement win over live and presentation mutations', () => {
		const kinds = new Set(['replacement', 'live-append', 'presentation-structure'] as const);
		expect(conversationFeedEndBehavior(kinds, true)).toBe('explicit-navigation');
	});

	it('restores only live-window appends and presentation structure', () => {
		expect(conversationFeedEndBehavior(new Set(['live-append']), true)).toBe('restore-if-pinned');
		expect(conversationFeedEndBehavior(new Set(['presentation-structure']), true)).toBe(
			'restore-if-pinned',
		);
		expect(conversationFeedEndBehavior(new Set(['history-pruned']), true)).toBe(
			'restore-if-pinned',
		);
		expect(conversationFeedEndBehavior(new Set(['live-append']), false)).toBe(
			'preserve-reading-position',
		);
		expect(conversationFeedEndBehavior(new Set(['history-later']), true)).toBe(
			'preserve-reading-position',
		);
	});
});
