import { describe, expect, it } from 'vitest';
import {
	AssistantMessage,
	BashToolUseMessage,
	GlobToolUseMessage,
	ToolResultMessage,
	UserMessage,
} from '$shared/chat-types';
import {
	ActiveTranscriptState,
	type ChatDisplayRow,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ConversationFeedMutationClock } from '$lib/chat/transcript/conversation-feed-mutations.js';
import { ConversationFeedProjectionState } from '../ConversationFeedProjectionState.svelte.js';
import { estimateConversationFeedItemSize } from '../conversation-feed-virtual-items.js';

const TS = '2026-08-03T00:00:00.000Z';
type ProjectionInput = Parameters<ConversationFeedProjectionState['reconcile']>[0];

const NO_HIDDEN_TOOL_TYPES: ProjectionInput['hiddenToolTypes'] = [];
const NO_FLOATING_PERMISSIONS: ProjectionInput['floatingPermissions'] = [];

function clock(
	dataRevision: number,
	overrides: Partial<ConversationFeedMutationClock['lastRevisionByKind']> = {},
): ConversationFeedMutationClock {
	return {
		dataRevision,
		lastResponseRevisionByMessageType:
			overrides['live-append'] === undefined
				? {}
				: { 'assistant-message': overrides['live-append'] },
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

function input(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
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

	it('keeps hidden result rows canonical but excludes them from virtual geometry', () => {
		const projection = new ConversationFeedProjectionState().reconcile(
			input({
				rows: [
					{
						kind: 'message',
						id: 'generation-1:1',
						message: new BashToolUseMessage(TS, 'bash-1', 'pwd'),
					},
					{
						kind: 'message',
						id: 'generation-1:2',
						message: new ToolResultMessage(TS, 'bash-1', { raw: '/tmp' }, false),
					},
					{
						kind: 'message',
						id: 'generation-1:3',
						message: new GlobToolUseMessage(TS, 'glob-1', '**/*.ts'),
					},
					{
						kind: 'message',
						id: 'generation-1:4',
						message: new ToolResultMessage(TS, 'glob-1', { filenames: ['a.ts'] }, false),
					},
				],
			}),
		);

		expect(projection.renderModel.items.map((item) => item.id)).toEqual([
			'generation-1:1',
			'generation-1:2',
			'generation-1:3',
			'generation-1:4',
		]);
		expect(projection.model.indexByRowId.has('generation-1:2')).toBe(false);
		expect(projection.model.indexByRowId.has('generation-1:4')).toBe(true);
		expect(projection.geometry.estimates).not.toContain(0);
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

	it('extends a deep transcript incrementally without evicting loaded rows', () => {
		const transcript = new ActiveTranscriptState();
		const projections = new ConversationFeedProjectionState();
		const initialCount = 249;
		const deepEntries = Array.from({ length: initialCount }, (_, index) => ({
			seq: index + 1,
			message:
				index % 2 === 0
					? new UserMessage(TS, `prompt ${index + 1}`)
					: new AssistantMessage(TS, `response ${index + 1}`),
		}));
		transcript.replaceGeneration('chat-1', 'generation-1', deepEntries, {
			lastSeq: initialCount,
			pageOldestSeq: 1,
			hasMore: false,
		});
		transcript.revealAllLoadedMessages();
		const initialRows = transcript.visibleRows;
		const first = projections.reconcile(
			input({ rows: initialRows, mutationClock: transcript.feedMutationClock }),
		);
		const oldEndKey = first.model.items.at(-1)?.key;

		transcript.applyMessages('chat-1', 'generation-1', [
			{
				seq: initialCount + 1,
				message: new AssistantMessage(TS, 'new response'),
			},
		]);
		const appendedRows = transcript.visibleRows;
		const appendedTail = appendedRows.at(-1);
		if (appendedTail?.kind !== 'message') throw new Error('Expected an appended transcript row');

		const appended = projections.reconcile(
			input({ rows: appendedRows, mutationClock: transcript.feedMutationClock }),
		);

		const appendedRowId = `generation-1:${initialCount + 1}`;
		expect(appendedRows).toHaveLength(initialCount + 1);
		expect(appendedRows[0]?.id).toBe(initialRows[0]?.id);
		expect(appended.renderModel.items[100]).toBe(first.renderModel.items[100]);
		expect(appended.model.items[101]).toBe(first.model.items[101]);
		expect(appended.model.indexByKey).not.toBe(first.model.indexByKey);
		expect(appended.model.indexByRowId).not.toBe(first.model.indexByRowId);
		expect(appended.model.targetByDomAnchorId).not.toBe(first.model.targetByDomAnchorId);
		expect(first.model.indexByRowId.has(appendedRowId)).toBe(false);
		expect(first.model.targetByDomAnchorId.has(appendedRowId)).toBe(false);
		expect(oldEndKey).toBeDefined();
		expect(first.model.indexByKey.get(oldEndKey!)).toBe(first.model.items.length - 1);
		expect(appended.model.indexByRowId.get(appendedRowId)).toBe(initialCount + 1);
		expect(appended.model.items.at(-2)).toMatchObject({
			kind: 'transcript',
			item: { message: appendedTail.message },
		});
		expect(appended.geometry.geometryRevision).toBeGreaterThan(first.geometry.geometryRevision);
		expect(appended.geometry.keys).toEqual(appended.model.items.map((item) => item.key));
		expect(appended.geometry.estimates).toEqual(
			appended.model.items.map((item) => estimateConversationFeedItemSize(item, 1)),
		);
	});

	it('never requests a global measurement reset for a same-surface count shrink', () => {
		const projections = new ConversationFeedProjectionState();
		const first = projections.reconcile(input());
		const shrunk = projections.reconcile(
			input({
				rows: rows().slice(0, 1),
				mutationClock: clock(2, { replacement: 2 }),
			}),
		);

		expect(shrunk.geometry.keys.length).toBeLessThan(first.geometry.keys.length);
		expect(shrunk.geometry.geometryRevision).toBeGreaterThan(first.geometry.geometryRevision);
		expect(shrunk.geometry.measurementReset).toBe('none');
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
