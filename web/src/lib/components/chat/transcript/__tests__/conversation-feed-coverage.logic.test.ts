import { expect, it } from 'vitest';
import { BashToolUseMessage } from '$shared/chat-types';
import { nextConversationCoverage } from '../conversation-feed-coverage.js';
import { buildConversationVirtualFeedModel } from '../conversation-feed-virtual-items.js';
import { certifiedFeed, displayGroup } from './display-feed-fixtures.js';
import { displayCertificate, displayOpen } from '$lib/chat/transcript/__tests__/display-fixtures.js';

function model() {
	const groups = [displayGroup(1, 100, 100), displayGroup(102, 200, 99)];
	const certificate = displayCertificate(displayOpen('chat-1', 'view-1', 200));
	return buildConversationVirtualFeedModel(certifiedFeed([50, 150].map(ordinal => ({ ordinal,
		message: new BashToolUseMessage('2026-01-01T00:00:00.000Z', `tool-${ordinal}`, 'true') })), {
		certificate, items: groups,
		display: { expansions: groups.map((group, index) => ({ anchorOrdinal: index ? 150 : 50, openedAt: index,
			page: { certificate, base: group.base, fragment: group.fragment, ordinals: [index ? 150 : 50],
				earlier: { beforeOrdinal: index ? 150 : 50, remaining: 49 }, later: { afterOrdinal: index ? 150 : 50, remaining: 49 } } })) },
	}));
}

it.each(['earlier', 'later'] as const)('fills members in the %s reading direction near the viewport', direction => {
	const feed = model(), index = feed.indexByRowId.get('view-1:150')!;
	const demand = nextConversationCoverage(feed, { startIndex: index, endIndex: index }, direction, { earlier: true, later: true });
	expect(demand).toMatchObject({ kind: 'member-boundary', group: { firstMember: 102 }, anchor: { kind: direction === 'earlier' ? 'before' : 'after' } });
});

it('fills the active parent edge instead of unrelated off-screen groups', () => {
	const feed = model();
	expect(nextConversationCoverage(feed, { startIndex: 0, endIndex: 0 }, 'later', { earlier: true, later: true })).toBe('later');
	expect(nextConversationCoverage(feed, null, 'earlier', { earlier: false, later: true })).toBe('later');
	expect(nextConversationCoverage(feed, null, 'later', { earlier: false, later: false })).toBeNull();
});
