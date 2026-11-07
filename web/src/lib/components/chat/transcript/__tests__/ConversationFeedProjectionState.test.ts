import { describe, expect, it } from 'vitest';
import { AssistantMessage, BashToolUseMessage, CommandOutputMessage, ToolResultMessage, UserMessage } from '$shared/chat-types';
import { EMPTY_CONVERSATION_FEED_MUTATION_REVISIONS, type ConversationFeedMutationClock } from '$lib/chat/transcript/conversation-feed-mutations.js';
import { displayCertificate, displayDetail, displayRow } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import { ConversationFeedProjectionState, type ConversationFeedProjectionInput } from '../ConversationFeedProjectionState.svelte.js';
import { estimateConversationFeedItemSize } from '../conversation-feed-virtual-items.js';
import { certifiedFeed, displayGroup } from './display-feed-fixtures.js';

function clock(dataRevision: number, lastRevisionByKind: Partial<ConversationFeedMutationClock['lastRevisionByKind']> = {}): ConversationFeedMutationClock {
	return { dataRevision, lastResponseRevisionByMessageType: {}, lastRevisionByKind: { ...EMPTY_CONVERSATION_FEED_MUTATION_REVISIONS, ...lastRevisionByKind } };
}
const rows = [displayRow(1, new UserMessage('', 'Prompt')), displayRow(2, new AssistantMessage('', 'Response'))];
function input(overrides: Partial<ConversationFeedProjectionInput> = {}): ConversationFeedProjectionInput {
	return { ...certifiedFeed(rows), mutationClock: clock(1, { initial: 1 }), isLiveWindow: true, ...overrides };
}

describe('ConversationFeedProjectionState', () => {
	it('passes certified render details through without rebuilding raw visibility or pairing', () => {
		const output = displayRow(1, new CommandOutputMessage('', 'command', 'stdout', 'markdown', '# Heading', null));
		const projections = new ConversationFeedProjectionState();
		const before = projections.reconcile(input({ ...certifiedFeed([output], { display: { details: new Map([[1, displayDetail(1, { commandFormat: 'plain' })]]) } }) }));
		const after = projections.reconcile(input({ ...certifiedFeed([output], { display: { details: new Map([[1, displayDetail(1, { commandFormat: 'markdown' })]]) } }),
			mutationClock: clock(2, { 'live-append': 2 }) }));
		expect(before.renderModel.items[0]).toMatchObject({ message: { format: 'plain' } });
		expect(after.renderModel.items[0]).toMatchObject({ message: { format: 'markdown' } });
		expect(after.geometry.geometryRevision).toBe(before.geometry.geometryRevision);
		expect(after.geometry.keys).toBe(before.geometry.keys);
		expect(after.geometry.endBehavior).toBe('restore-if-pinned');
		expect(after.projectedDataRevision).toBe(2);
	});

	it('updates aggregate counts without allocating member identities or replacing stable geometry', () => {
		const projections = new ConversationFeedProjectionState();
		const first = projections.reconcile(input({ ...certifiedFeed([], { items: [displayGroup(1, 100, 100)] }) }));
		const next = projections.reconcile(input({ ...certifiedFeed([], { items: [displayGroup(1, 40000, 40000)] }), mutationClock: clock(2, { 'live-append': 2 }) }));
		expect(next.model.items[1]).toMatchObject({ descriptor: { count: 40000 } });
		expect(next.model.items).toHaveLength(3);
		expect(next.model.indexByRowId.size).toBe(0);
		expect(next.geometry.keys).toEqual(first.geometry.keys);
		expect(next.geometry.geometryRevision).toBe(first.geometry.geometryRevision);
	});

	it('changes geometry for bounded disclosure and non-combined descriptors, not cached dependencies', () => {
		const projections = new ConversationFeedProjectionState();
		const group = displayGroup(1, 1000, 1000);
		const member = displayRow(1, new BashToolUseMessage('', 'tool', 'true'));
		const result = displayRow(1001, new ToolResultMessage('', 'tool', { raw: 'Generic output' }, false));
		const collapsed = projections.reconcile(input({ ...certifiedFeed([member, result], { items: [group] }) }));
		const expanded = projections.reconcile(input({ ...certifiedFeed([member, result], { items: [group], display: {
			expansions: [{ anchorOrdinal: 1, openedAt: 1, page: { certificate: displayCertificate(), base: group.base, fragment: group.fragment,
				ordinals: [1], earlier: null, later: { afterOrdinal: 1, remaining: 999 } } }],
			details: new Map([[1, displayDetail(1, { pairedResult: 1001 })]]),
		} }) }));
		expect(expanded.model.items[1].key).toBe(collapsed.model.items[1].key);
		expect(expanded.model.indexByRowId.size).toBe(1);
		expect(expanded.model.indexByRowId.has('view-1:1001')).toBe(false);
		expect(expanded.renderModel.toolResultRowIdByUseRowId.get('view-1:1')).toBe('view-1:1001');
		expect(expanded.geometry.geometryRevision).toBeGreaterThan(collapsed.geometry.geometryRevision);
		const ordinary = projections.reconcile(input({ ...certifiedFeed([member]) }));
		expect(ordinary.model.items.some(item => item.kind === 'tool-group')).toBe(false);
		expect(ordinary.model.indexByRowId.has('view-1:1')).toBe(true);
	});

	it('namespaces virtual identity without changing canonical row targets', () => {
		const projection = new ConversationFeedProjectionState().reconcile(input({ surfaceIdentity: 'chat:surface' }));
		expect(projection.model.items[1].key).toContain('chat:surface');
		expect(projection.model.indexByRowId.get('view-1:1')).toBe(1);
		expect(projection.renderModel.items[0].id).toBe('view-1:1');
	});

	it('rebuilds key indexes from filtered certificates without mutating the prior snapshot', () => {
		const projections = new ConversationFeedProjectionState();
		const first = projections.reconcile(input());
		const filtered = projections.reconcile(input({ ...certifiedFeed(rows.slice(0, 1)), mutationClock: clock(2, { 'presentation-structure': 2 }) }));
		expect(first.model.indexByRowId.has('view-1:2')).toBe(true);
		expect(filtered.model.indexByRowId.has('view-1:2')).toBe(false);
		expect(filtered.model.indexByKey).not.toBe(first.model.indexByKey);
		expect(filtered.geometry.measurementReset).toBe('none');
		expect(filtered.geometry.endBehavior).toBe('restore-if-pinned');
		expect(filtered.geometry.estimates).toEqual(filtered.model.items.map(estimateConversationFeedItemSize));
	});

	it('does not reset surviving measurements when retention shrinks the working interval', () => {
		const projections = new ConversationFeedProjectionState();
		const first = projections.reconcile(input());
		const shrunk = projections.reconcile(input({ ...certifiedFeed(rows.slice(1)), isLiveWindow: false, mutationClock: clock(2, { 'presentation-structure': 2 }) }));
		expect(shrunk.geometry.geometryRevision).toBeGreaterThan(first.geometry.geometryRevision);
		expect(shrunk.geometry.measurementReset).toBe('none');
		expect(shrunk.geometry.endBehavior).toBe('preserve-reading-position');
	});

	it('publishes changed end geometry for the composer reservation', () => {
		const projections = new ConversationFeedProjectionState();
		const first = projections.reconcile(input());
		const reserved = projections.reconcile(input({ reserveComposerCapSpace: true }));
		expect(reserved.geometry.keys).toEqual(first.geometry.keys);
		expect(reserved.geometry.geometryRevision).toBeGreaterThan(first.geometry.geometryRevision);
		expect(reserved.geometry.estimates.at(-1)).toBe(56);
	});

	it('gives explicit navigation precedence over coalesced live append', () => {
		const projections = new ConversationFeedProjectionState();
		projections.reconcile(input());
		const replaced = projections.reconcile(input({ ...certifiedFeed([...rows, displayRow(3)]), mutationClock: clock(3, { replacement: 2, 'live-append': 3 }) }));
		expect(replaced.geometry.mutationKinds).toEqual(new Set(['replacement', 'live-append']));
		expect(replaced.geometry.endBehavior).toBe('explicit-navigation');
	});
});
