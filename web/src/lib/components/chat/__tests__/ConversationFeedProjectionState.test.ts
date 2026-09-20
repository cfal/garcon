import { describe, expect, it } from 'vitest';
import { AssistantMessage, BashToolUseMessage, GrepToolUseMessage, ReadToolUseMessage, ThinkingMessage, ToolResultMessage, UserMessage } from '$shared/chat-types';
import {
	ActiveTranscriptState,
	type ChatDisplayRow,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ConversationFeedMutationClock } from '$lib/chat/transcript/conversation-feed-mutations.js';
import { compileHiddenBashCommandPatterns } from '$lib/chat/transcript/hidden-bash-commands.js';
import { ACTIVE_TRANSCRIPT_RETENTION_LIMIT } from '$lib/chat/transcript/transcript-page-progress.js';
import { ConversationFeedProjectionState } from '../ConversationFeedProjectionState.svelte.js';
import { estimateConversationFeedItemSize } from '../conversation-feed-virtual-items.js';

const TS = '2026-08-03T00:00:00.000Z';
type ProjectionInput = Parameters<ConversationFeedProjectionState['reconcile']>[0];

const NO_HIDDEN_TOOL_TYPES: ProjectionInput['hiddenToolTypes'] = [];
const NO_PENDING_PERMISSIONS: ProjectionInput['pendingPermissions'] = [];

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
		hiddenBashCommands: null,
		showThinking: true,
		combineToolUseMessages: false,
		expandedToolMemberIds: new Set(),
		protectedVirtualKeys: [],
		isLiveWindow: true,
		showRefreshError: false,
		earlierBoundary: 'hidden',
		showLaterBoundary: false,
		reserveComposerTraySpace: false,
		transcriptViewId: 'generation-1',
		pendingPermissions: NO_PENDING_PERMISSIONS,
		...overrides,
	};
}

describe('ConversationFeedProjectionState', () => {
	it('groups only visible adjacent ordinary inputs after result and thinking policy', () => {
		const projectedRows: ChatDisplayRow[] = [
			{ kind: 'message', id: 'generation-1:1', message: new BashToolUseMessage(TS, 'a', 'pwd') },
			{ kind: 'message', id: 'generation-1:2', message: new ToolResultMessage(TS, 'a', { raw: 'ok' }, false) },
			{ kind: 'message', id: 'generation-1:3', message: new ThinkingMessage(TS, 'hidden') },
			{ kind: 'message', id: 'generation-1:4', message: new ReadToolUseMessage(TS, 'b', '/a') },
			{ kind: 'message', id: 'generation-1:5', message: new GrepToolUseMessage(TS, 'c', 'needle') },
			{ kind: 'message', id: 'generation-1:6', message: new ToolResultMessage(TS, 'c', { raw: 'match' }, false) },
			{ kind: 'message', id: 'generation-1:7', message: new ReadToolUseMessage(TS, 'd', '/b') },
			{ kind: 'message', id: 'generation-1:8', message: new AssistantMessage(TS, 'done') },
		];
		const projection = new ConversationFeedProjectionState().reconcile(input({
			rows: projectedRows,
			showThinking: false,
			combineToolUseMessages: true,
		}));
		const groups = projection.model.items.filter((item) => item.kind === 'tool-group');
		expect(groups).toHaveLength(2);
		expect(groups[0]?.members.map((member) => member.item.id)).toEqual([
			'generation-1:1', 'generation-1:4', 'generation-1:5',
		]);
		expect(groups[1]?.members.map((member) => member.item.id)).toEqual([
			'generation-1:7',
		]);
		expect(projection.model.indexByRowId.get('generation-1:1')).toBe(
			projection.model.indexByRowId.get('generation-1:5'),
		);
		expect(projection.model.indexByRowId.has('generation-1:2')).toBe(false);
		expect(projection.model.indexByRowId.has('generation-1:3')).toBe(false);
		expect(projection.model.items[projection.model.indexByRowId.get('generation-1:6')!]).toMatchObject({ kind: 'transcript' });
		expect(projection.model.items[projection.model.indexByRowId.get('generation-1:7')!]).toMatchObject({ kind: 'tool-group' });
		expect(projection.renderModel.toolResultRowIdByUseRowId.get('generation-1:5')).toBe('generation-1:6');
	});

	it('rebuilds grouped membership on tail append, disclosure, and setting changes', () => {
		const firstRows: ChatDisplayRow[] = [
			{ kind: 'message', id: 'generation-1:1', message: new ReadToolUseMessage(TS, 'a', '/a') },
		];
		const secondRows = [
			...firstRows,
			{ kind: 'message' as const, id: 'generation-1:2', message: new ReadToolUseMessage(TS, 'b', '/b') },
		];
		const thirdRows = [
			...secondRows,
			{ kind: 'message' as const, id: 'generation-1:3', message: new ReadToolUseMessage(TS, 'c', '/c') },
		];
		const projections = new ConversationFeedProjectionState();
		const first = projections.reconcile(input({ rows: firstRows, combineToolUseMessages: true }));
		const firstGroup = first.model.items.find((item) => item.kind === 'tool-group');
		expect(firstGroup?.members).toHaveLength(1);
		const second = projections.reconcile(input({ rows: secondRows, combineToolUseMessages: true, mutationClock: clock(2, { 'live-append': 2 }) }));
		const secondGroup = second.model.items.find((item) => item.kind === 'tool-group');
		expect(secondGroup?.key).toBe(firstGroup?.key);
		expect(secondGroup?.members).toHaveLength(2);
		const third = projections.reconcile(input({ rows: thirdRows, combineToolUseMessages: true, mutationClock: clock(3, { 'live-append': 3 }) }));
		const thirdGroup = third.model.items.find((item) => item.kind === 'tool-group');
		expect(thirdGroup?.key).toBe(secondGroup?.key);
		expect(thirdGroup?.members).toHaveLength(3);
		expect(third.geometry.geometryRevision).toBeGreaterThan(second.geometry.geometryRevision);
		const expandedIds = new Set(['generation-1:2']);
		const expanded = projections.reconcile(input({ rows: thirdRows, combineToolUseMessages: true, expandedToolMemberIds: expandedIds, mutationClock: clock(3, { 'live-append': 3 }) }));
		expect(expanded.model.items.filter((item) => item.kind === 'transcript')).toHaveLength(3);
		expect(expanded.model.items.find((item) => item.kind === 'tool-group')?.expanded).toBe(true);
		const off = projections.reconcile(input({ rows: thirdRows, combineToolUseMessages: false, mutationClock: clock(3, { 'live-append': 3 }) }));
		expect(off.model.items.some((item) => item.kind === 'tool-group')).toBe(false);
		expect(off.model.indexByRowId.size).toBe(3);
	});
	it('namespaces virtual keys without changing semantic row targets', () => {
		const projection = new ConversationFeedProjectionState().reconcile(input());

		expect(projection.model.items[0]?.key).toContain('chat-1:generation-1');
		expect(projection.model.indexByRowId.get('generation-1:1')).toBe(1);
		expect(projection.renderModel.items[0]?.id).toBe('generation-1:1');
	});

	it('hides pattern-matched bash rows and rebuilds geometry when the matcher changes', () => {
		const bashRows: ChatDisplayRow[] = [
			{ kind: 'message', id: 'generation-1:1', message: new UserMessage(TS, 'prompt') },
			{
				kind: 'message',
				id: 'generation-1:2',
				message: new BashToolUseMessage(TS, 'bash-1', 'git status'),
			},
			{
				kind: 'message',
				id: 'generation-1:3',
				message: new ToolResultMessage(TS, 'bash-1', { raw: 'ok' }, false),
			},
			{ kind: 'message', id: 'generation-1:4', message: new AssistantMessage(TS, 'done') },
		];
		const mutationClock = clock(3, { replacement: 1, 'live-append': 3 });
		const projections = new ConversationFeedProjectionState();
		const initial = projections.reconcile(input({ rows: bashRows, mutationClock }));

		expect(initial.model.indexByRowId.has('generation-1:2')).toBe(true);

		const hidden = projections.reconcile(
			input({
				rows: bashRows,
				mutationClock,
				hiddenBashCommands: compileHiddenBashCommandPatterns([
					{ pattern: 'git *', mode: 'glob' },
				]),
			}),
		);

		expect(hidden.model.indexByRowId.has('generation-1:2')).toBe(false);
		expect(hidden.model.indexByRowId.has('generation-1:1')).toBe(true);
		expect(hidden.model.indexByRowId.has('generation-1:4')).toBe(true);
		expect(hidden.geometry).not.toBe(initial.geometry);

		const restored = projections.reconcile(
			input({
				rows: bashRows,
				mutationClock,
				hiddenBashCommands: null,
			}),
		);

		expect(restored.model.indexByRowId.has('generation-1:2')).toBe(true);
		expect(restored.model.indexByRowId.has('generation-1:3')).toBe(false);
		expect(restored.renderModel.items).toHaveLength(4);
		expect(restored.geometry).not.toBe(hidden.geometry);
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

	it('extends a retained transcript incrementally below the retention limit', () => {
		const transcript = new ActiveTranscriptState();
		const projections = new ConversationFeedProjectionState();
		const initialCount = ACTIVE_TRANSCRIPT_RETENTION_LIMIT - 1;
		const deepEntries = Array.from({ length: initialCount }, (_, index) => ({
			ordinal: index + 1,
			message:
				index % 2 === 0
					? new UserMessage(TS, `prompt ${index + 1}`)
					: new AssistantMessage(TS, `response ${index + 1}`),
		}));
		transcript.replaceGeneration('chat-1', 'generation-1', deepEntries, {
			lastOrdinal: initialCount,
			pageOldestOrdinal: 1,
			nextBeforeOrdinal: null,
			hasMore: false,
		});
		transcript.revealAllLoadedMessages();
		const initialRows = transcript.visibleRows;
		const first = projections.reconcile(
			input({ rows: initialRows, mutationClock: transcript.feedMutationClock }),
		);
		const oldEndKey = first.model.items.at(-1)?.key;

		transcript.applyMessages(
			'chat-1',
			'generation-1',
			[
				{
					ordinal: ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
					message: new AssistantMessage(TS, 'new response'),
				},
			],
			ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
			ACTIVE_TRANSCRIPT_RETENTION_LIMIT,
		);
		const appendedRows = transcript.visibleRows;
		const appendedTail = appendedRows.at(-1);
		if (appendedTail?.kind !== 'message') throw new Error('Expected an appended transcript row');

		const appended = projections.reconcile(
			input({ rows: appendedRows, mutationClock: transcript.feedMutationClock }),
		);

		const appendedRowId = `generation-1:${ACTIVE_TRANSCRIPT_RETENTION_LIMIT}`;
		expect(appendedRows).toHaveLength(ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
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
		expect(appended.model.indexByRowId.get(appendedRowId)).toBe(ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
		expect(appended.model.items.at(-2)).toMatchObject({
			kind: 'transcript',
			item: { message: appendedTail.message },
		});
		expect(appended.geometry.geometryRevision).toBeGreaterThan(first.geometry.geometryRevision);
		expect(appended.geometry.keys).toEqual(appended.model.items.map((item) => item.key));
		expect(appended.geometry.estimates).toEqual(
			appended.model.items.map(estimateConversationFeedItemSize),
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
