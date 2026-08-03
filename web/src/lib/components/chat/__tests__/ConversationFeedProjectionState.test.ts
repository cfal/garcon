import { describe, expect, it } from 'vitest';
import { AssistantMessage, UserMessage } from '$shared/chat-types';
import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ConversationFeedMutationClock } from '$lib/chat/transcript/conversation-feed-mutations.js';
import { ConversationFeedProjectionState } from '../ConversationFeedProjectionState.svelte.js';
import { estimateConversationFeedItemSize } from '../conversation-feed-virtual-items.js';

const TS = '2026-08-03T00:00:00.000Z';
type TranscriptMessageRow = Extract<ChatDisplayRow, { kind: 'message' }>;
type ProjectionInput = Parameters<ConversationFeedProjectionState['reconcile']>[0];

const NO_HIDDEN_TOOL_TYPES: ProjectionInput['hiddenToolTypes'] = [];
const NO_FLOATING_PERMISSIONS: ProjectionInput['floatingPermissions'] = [];

function clock(
	dataRevision: number,
	overrides: Partial<ConversationFeedMutationClock['lastRevisionByKind']> = {},
): ConversationFeedMutationClock {
	return {
		dataRevision,
		lastResponseRevision: overrides['live-append'] ?? 0,
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
	overrides: Partial<ProjectionInput> = {},
): ProjectionInput {
	return {
		surfaceIdentity: 'chat-1:generation-1',
		rows: rows(),
		mutationClock: clock(1, { replacement: 1 }),
		hiddenToolTypes: NO_HIDDEN_TOOL_TYPES,
		showThinking: true,
		textScale: 1,
		isLiveWindow: true,
		showTopToolbarSpacer: false,
		showRefreshError: false,
		showEarlierBoundary: false,
		showLaterBoundary: false,
		reserveComposerTraySpace: false,
		floatingPermissions: NO_FLOATING_PERMISSIONS,
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

	it('reconciles a streamed tail without rebuilding a deep transcript', () => {
		const projections = new ConversationFeedProjectionState();
		const deepRows = Array.from({ length: 20_000 }, (_, index): TranscriptMessageRow => ({
			kind: 'message',
			id: `generation-1:${index + 1}`,
			seq: index + 1,
			message: new AssistantMessage(TS, `response ${index + 1}`),
		}));
		const first = projections.reconcile(
			input({ rows: deepRows, mutationClock: clock(1, { replacement: 1 }) }),
		);
		const nextRows = deepRows.slice();
		nextRows[nextRows.length - 1] = {
			...nextRows[nextRows.length - 1],
			message: new AssistantMessage(TS, 'streamed response'),
		};

		const streamed = projections.reconcile(
			input({ rows: nextRows, mutationClock: clock(2, { 'live-append': 2 }) }),
		);

		expect(streamed.renderModel.items[10_000]).toBe(first.renderModel.items[10_000]);
		expect(streamed.model.items[10_001]).toBe(first.model.items[10_001]);
		expect(streamed.model.indexByRowId).toBe(first.model.indexByRowId);
		expect(streamed.model.items.at(-2)).toMatchObject({
			kind: 'transcript',
			item: { message: nextRows.at(-1)?.message },
		});
		expect(streamed.geometry).toBe(first.geometry);
	});

	it('extends deep transcript indexes incrementally for assistant appends', () => {
		const projections = new ConversationFeedProjectionState();
		const deepRows = Array.from({ length: 20_000 }, (_, index): TranscriptMessageRow => ({
			kind: 'message',
			id: `generation-1:${index + 1}`,
			seq: index + 1,
			message: new AssistantMessage(TS, `response ${index + 1}`),
		}));
		const first = projections.reconcile(
			input({ rows: deepRows, mutationClock: clock(1, { replacement: 1 }) }),
		);
		const appendedRows = [
			...deepRows,
			{
				kind: 'message' as const,
				id: 'generation-1:20001',
				seq: 20_001,
				message: new AssistantMessage(TS, 'new response'),
			},
		];

		const appended = projections.reconcile(
			input({ rows: appendedRows, mutationClock: clock(2, { 'live-append': 2 }) }),
		);

		expect(appended.renderModel.items[10_000]).toBe(first.renderModel.items[10_000]);
		expect(appended.model.indexByRowId).toBe(first.model.indexByRowId);
		expect(appended.model.indexByRowId.get('generation-1:20001')).toBe(20_001);
		expect(appended.model.items.at(-2)).toMatchObject({
			kind: 'transcript',
			item: { message: appendedRows.at(-1)?.message },
		});
		expect(appended.geometry.geometryRevision).toBeGreaterThan(first.geometry.geometryRevision);
		expect(appended.geometry.keys).toEqual(appended.model.items.map((item) => item.key));
		expect(appended.geometry.estimates).toEqual(
			appended.model.items.map((item) => estimateConversationFeedItemSize(item, 1)),
		);
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
