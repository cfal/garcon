import { describe, expect, it } from 'vitest';
import { AssistantMessage, UserMessage } from '$shared/chat-types';
import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ConversationFeedMutationClock } from '$lib/chat/transcript/conversation-feed-mutations.js';
import { ConversationFeedProjectionState } from '../ConversationFeedProjectionState.svelte.js';

const TS = '2026-08-03T00:00:00.000Z';

function clock(
	dataRevision: number,
	overrides: Partial<ConversationFeedMutationClock['lastRevisionByKind']> = {},
): ConversationFeedMutationClock {
	return {
		dataRevision,
		lastRevisionByKind: {
			initial: 0,
			'live-append': 0,
			'history-earlier': 0,
			'history-later': 0,
			replacement: 0,
			'presentation-structure': 0,
			...overrides,
		},
	};
}

function rows(content = 'hello'): ChatDisplayRow[] {
	return [
		{ kind: 'message', id: 'generation-1:1', message: new UserMessage(TS, 'prompt') },
		{ kind: 'message', id: 'generation-1:2', message: new AssistantMessage(TS, content) },
	];
}

function input(
	overrides: Partial<Parameters<ConversationFeedProjectionState['reconcile']>[0]> = {},
): Parameters<ConversationFeedProjectionState['reconcile']>[0] {
	return {
		surfaceIdentity: 'chat-1:generation-1',
		rows: rows(),
		mutationClock: clock(1, { replacement: 1 }),
		hiddenToolTypes: [],
		showThinking: true,
		textScale: 1,
		isLiveWindow: true,
		showTopToolbarSpacer: false,
		showRefreshError: false,
		showEarlierBoundary: false,
		showLaterBoundary: false,
		reserveComposerTraySpace: false,
		floatingPermissions: [],
		...overrides,
	};
}

describe('ConversationFeedProjectionState', () => {
	it('namespaces virtual keys without changing semantic row targets', () => {
		const projection = new ConversationFeedProjectionState().reconcile(input());

		expect(projection.model.items[0]?.key).toContain('chat-1:generation-1');
		expect(projection.model.indexByRowId.get('generation-1:1')).toBe(1);
		expect(projection.renderModel.items[0]?.id).toBe('generation-1:1');
	});

	it('acknowledges content-only streaming without publishing new geometry', () => {
		const projections = new ConversationFeedProjectionState();
		const first = projections.reconcile(input());
		const streamed = projections.reconcile(
			input({
				rows: rows('hello world'),
				mutationClock: clock(2, { replacement: 1, 'live-append': 2 }),
			}),
		);

		expect(streamed.projectedDataRevision).toBe(2);
		expect(streamed.geometry).toBe(first.geometry);
		expect(streamed.renderModel).not.toBe(first.renderModel);
	});

	it('marks text scale as a full measurement reset while retaining stable keys', () => {
		const projections = new ConversationFeedProjectionState();
		const first = projections.reconcile(input());
		const scaled = projections.reconcile(input({ textScale: 0.85 }));

		expect(scaled.geometry.keys).toEqual(first.geometry.keys);
		expect(scaled.geometry.geometryRevision).toBeGreaterThan(first.geometry.geometryRevision);
		expect(scaled.geometry.measurementReset).toBe('all');
	});

	it('publishes changed end geometry when the composer tray reservation changes', () => {
		const projections = new ConversationFeedProjectionState();
		const first = projections.reconcile(input());
		const reserved = projections.reconcile(input({ reserveComposerTraySpace: true }));

		expect(reserved.geometry.keys).toEqual(first.geometry.keys);
		expect(reserved.geometry.geometryRevision).toBeGreaterThan(first.geometry.geometryRevision);
		expect(reserved.geometry.estimates.at(-1)).toBe(56);
	});

	it('reduces coalesced replacement and live append to explicit navigation', () => {
		const projections = new ConversationFeedProjectionState();
		projections.reconcile(input());
		const replaced = projections.reconcile(
			input({
				rows: [
					...rows(),
					{
						kind: 'message',
						id: 'generation-1:3',
						message: new AssistantMessage(TS, 'new'),
					},
				],
				mutationClock: clock(3, { replacement: 2, 'live-append': 3 }),
			}),
		);

		expect(replaced.geometry.mutationKinds).toEqual(new Set(['replacement', 'live-append']));
		expect(replaced.geometry.endBehavior).toBe('explicit-navigation');
	});
});
