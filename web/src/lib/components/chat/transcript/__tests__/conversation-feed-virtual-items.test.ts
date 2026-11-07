import { describe, expect, it } from 'vitest';
import { BashToolUseMessage, CommandOutputMessage, ExitPlanModeToolUseMessage, PermissionRequestMessage, TranscriptNoticeMessage, UserMessage } from '$shared/chat-types';
import type { PendingPermissionRequest } from '$lib/types/chat';
import { displayCertificate, displayDetail, displayRow } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import { buildConversationVirtualFeedModel, estimateConversationFeedItemSize, groupContainingRow } from '../conversation-feed-virtual-items.js';
import { certifiedFeed, displayGroup } from './display-feed-fixtures.js';
import { remapConversationAnchor } from '../conversation-feed-anchor-remapping.js';

const user = (ordinal: number) => displayRow(ordinal, new UserMessage('', `Message ${ordinal}`));
const bash = (ordinal: number) => displayRow(ordinal, new BashToolUseMessage('', 'reused-tool-id', 'true'));
const permission = (id: string): PendingPermissionRequest => ({ chatId: 'chat-1', permissionOccurrenceId: id,
	requestedTool: new BashToolUseMessage('', 'tool-1', 'true') });
const build = (input: ReturnType<typeof certifiedFeed>) => buildConversationVirtualFeedModel(input);

describe('certified virtual feed', () => {
	it.each(['direct', 'semantic', 'fallback'] as const)('excludes retained summary islands from %s anchor remapping', match => {
		const group = displayGroup(10, 20, 11), row = certifiedFeed([user(100)]).display.window!.items[0];
		const previous = build(certifiedFeed([user(100)], { items: [group, row] }));
		const next = build(certifiedFeed([user(100)], { display: {
			protectedGroups: [{ certificate: displayCertificate(), descriptor: match === 'semantic' ? displayGroup(11, 20, 10) : group }],
		} }));
		const groupKey = previous.items.find(item => item.kind === 'tool-group')!.key;
		const rowKey = previous.items[previous.indexByRowId.get('view-1:100')!].key;
		const selected = remapConversationAnchor({ key: match === 'fallback' ? 'removed' : groupKey,
			viewportOffset: 0, fallbackKeys: [groupKey, rowKey] }, previous, next);
		expect(selected?.anchor.key).toBe(rowKey);
		expect(selected?.anchor.fallbackKeys).not.toContain(next.items.find(item => item.kind === 'tool-group')!.key);
	});
	it('places optimistic inputs after hidden anchors before the next visible row', () => {
		const input = certifiedFeed([user(10), user(20)], { input: {
			overlays: [{ kind: 'message', id: 'optimistic:pending', message: new UserMessage('', 'Pending input') }],
			optimisticAfterOrdinals: new Map([['pending', 15]]),
		} });
		input.display = { ...input.display, window: { ...input.display.window!,
			cutPlacements: [{ id: 'optimistic:pending', placement: 'inline' }] } };
		expect(build(input).items.flatMap(item => item.kind === 'transcript' ? [item.item.id] : []))
			.toEqual(['view-1:10', 'optimistic:pending', 'view-1:20']);
	});

	it.each(['permission', 'plan'] as const)('does not float an actionable %s already rendered as a protected island', kind => {
		const request = kind === 'permission' ? permission('permission-1') : {
			...permission('plan:view-1:2'), requestedTool: new ExitPlanModeToolUseMessage('', 'plan-1', 'Synthetic plan'),
			planReference: { serverInstanceId: 'instance-1', chatId: 'chat-1', transcriptViewId: 'view-1', ordinal: 2 },
		};
		const message = kind === 'permission'
			? new PermissionRequestMessage('', 'permission-1', request.requestedTool) : request.requestedTool;
		const input = certifiedFeed([displayRow(2, message)], { items: [], display: {
			protectedRows: [{ certificate: displayCertificate(), detail: displayDetail(2), layout: kind === 'permission' ? 'permission' : 'standard' }],
		}, input: { pendingPermissions: [request] } });
		expect(build(input).items.filter(item => item.kind === 'transcript')).toHaveLength(1);
		expect(build(input).items.filter(item => item.kind === 'permission')).toHaveLength(0);
	});
	it('orders hidden-anchor inputs before intervening protected rows', () => {
		const input = certifiedFeed([user(10), user(18), user(20)], { items: certifiedFeed([user(10), user(20)]).display.window!.items,
			display: { protectedRows: [{ certificate: displayCertificate(), detail: displayDetail(18), layout: 'standard' }] },
			input: { overlays: [{ kind: 'message', id: 'optimistic:pending', message: new UserMessage('', 'Pending input') }],
				optimisticAfterOrdinals: new Map([['pending', 15]]) } });
		input.display = { ...input.display, window: { ...input.display.window!, cutPlacements: [{ id: 'optimistic:pending', placement: 'inline' }] } };
		expect(build(input).items.flatMap(item => item.kind === 'transcript' ? [item.item.id] : []))
			.toEqual(['view-1:10', 'optimistic:pending', 'view-1:18', 'view-1:20']);
	});
	it('renders a selected plan occurrence once when resident and floats it when absent', () => {
		const message = new ExitPlanModeToolUseMessage('', 'reused-plan', 'Synthetic plan');
		const request: PendingPermissionRequest = { chatId: 'chat-1', permissionOccurrenceId: 'plan:view-1:2', requestedTool: message,
			planReference: { serverInstanceId: 'instance-1', chatId: 'chat-1', transcriptViewId: 'view-1', ordinal: 2 } };
		const input = certifiedFeed([displayRow(2, message)], { input: { pendingPermissions: [request] } });
		expect(build(input).items.filter(item => item.kind === 'transcript')).toHaveLength(1);
		expect(build(input).items.filter(item => item.kind === 'permission')).toHaveLength(0);
		expect(build({ ...input, display: { ...input.display, window: null } }).items.filter(item => item.kind === 'permission')).toHaveLength(1);
	});
	it.each([false, true])('orders filtered-tail islands before a fragment cut, expanded=%s', expanded => {
		const group = { ...displayGroup(1, 90, 90), fragment: { after: 0, through: 100 } };
		const input = certifiedFeed([bash(50), bash(95)], { items: [group], display: {
			protectedRows: [{ certificate: displayCertificate(), detail: displayDetail(95), layout: 'standard' }],
			expansions: expanded ? [{ anchorOrdinal: 50, openedAt: 1, page: { certificate: displayCertificate(), base: group.base,
				fragment: group.fragment, ordinals: [50], earlier: { beforeOrdinal: 50, remaining: 49 }, later: { afterOrdinal: 50, remaining: 40 } } }] : [],
		}, input: { overlays: [{ kind: 'message', id: 'optimistic:pending', message: new UserMessage('', 'Pending input') }],
			optimisticAfterOrdinals: new Map([['pending', 100]]) } });
		input.display = { ...input.display, window: { ...input.display.window!, cutPlacements: [{ id: 'optimistic:pending', placement: 'inline' }] } };
		const model = build(input);
		expect(model.items.flatMap(item => item.kind === 'transcript' ? [item.item.id] : []))
			.toEqual(expanded ? ['view-1:50', 'view-1:95', 'optimistic:pending'] : ['view-1:95', 'optimistic:pending']);
		if (expanded) expect(model.indexByRowId.get('view-1:95')).toBeGreaterThan(model.items.findLastIndex(item => item.kind === 'member-boundary'));
	});
	it('orders inline overlays before an intervening retained group island', () => {
		const group = displayGroup(18, 19, 2);
		const input = certifiedFeed([user(10), user(20)], { display: {
			protectedGroups: [{ certificate: displayCertificate(), descriptor: group }],
		}, input: { overlays: [{ kind: 'message', id: 'optimistic:pending', message: new UserMessage('', 'Pending input') }],
			optimisticAfterOrdinals: new Map([['pending', 15]]) } });
		input.display = { ...input.display, window: { ...input.display.window!, cutPlacements: [{ id: 'optimistic:pending', placement: 'inline' }] } };
		expect(build(input).items.flatMap(item => item.kind === 'transcript' ? [item.item.id] : item.kind === 'tool-group' ? [item.anchorId] : []))
			.toEqual(['view-1:10', 'optimistic:pending', 'tool-group:view-1:18', 'view-1:20']);
	});
	it('represents 40,000 collapsed members with one descriptor and no per-member indexes', () => {
		const group = displayGroup(2, 40001, 40000);
		const input = certifiedFeed([user(1)], { items: [{ kind: 'row', ordinal: 1, messageType: 'user-message', layout: 'standard', estimatedBodyBytes: 100, permissionOccurrenceId: null }, group] });
		const model = build(input);
		expect(model.items).toHaveLength(4);
		expect(model.items[2]).toMatchObject({ kind: 'tool-group', descriptor: { count: 40000 }, expanded: false });
		expect(model.indexByRowId.size).toBe(1);
		expect(groupContainingRow(model, 'view-1:20000')).toBe(model.items[2]);
		expect(groupContainingRow(model, 'different-view:20000')).toBeUndefined();
		expect(estimateConversationFeedItemSize(model.items[2])).toBe(36);
	});

	it('flattens a bounded member page with exact directional boundaries and a stable header', () => {
		const group = displayGroup(1, 1000, 1000);
		const input = certifiedFeed([bash(500), bash(501)], { items: [group] });
		const collapsed = build(input);
		const expandedInput = certifiedFeed([bash(500), bash(501)], { items: [group], display: { expansions: [{ anchorOrdinal: 500, openedAt: 1,
			page: { certificate: input.display.window!.certificate, base: group.base, fragment: group.fragment, ordinals: [500, 501],
				earlier: { beforeOrdinal: 500, remaining: 499 }, later: { afterOrdinal: 501, remaining: 499 } } }] } });
		const expanded = build(expandedInput);
		expect(expanded.items.slice(1, -1).map(item => item.kind)).toEqual(['tool-group', 'member-boundary', 'transcript', 'transcript', 'member-boundary']);
		expect(expanded.items[1].key).toBe(collapsed.items[1].key);
		expect(expanded.indexByRowId.get('view-1:500')).toBe(3);
		expect(groupContainingRow(expanded, 'view-1:500')).toBeUndefined();
		expect(expanded.indexByRowId.size).toBe(2);
	});

	it('trusts certified singleton groups and does not regroup across ordinary rows', () => {
		const row = certifiedFeed([user(2)]).display.window!.items[0];
		const model = build(certifiedFeed([user(2)], { items: [displayGroup(1, 1, 1), row, displayGroup(3, 3, 1)] }));
		expect(model.items.slice(1, -1).map(item => item.kind)).toEqual(['tool-group', 'transcript', 'tool-group']);
	});

	it('renders optional compressed paging only when a collapsed group is represented', () => {
		const ordinary = build(certifiedFeed([user(1)], { input: { earlierBoundary: 'when-collapsed' } }));
		const collapsed = build(certifiedFeed([], { items: [displayGroup(1, 10, 10)], input: { earlierBoundary: 'when-collapsed' } }));
		expect(ordinary.items.some(item => item.kind === 'earlier-boundary')).toBe(false);
		expect(collapsed.items.some(item => item.kind === 'earlier-boundary')).toBe(true);
	});

	it('places off-window protected islands outside page boundaries with explicit gaps', () => {
		const input = certifiedFeed([user(20), user(40), user(500), user(700), user(900)], { items: certifiedFeed([user(500)]).display.window!.items,
			display: { protectedRows: [20, 40, 700, 900].map(ordinal => ({ certificate: displayCertificate(), detail: displayDetail(ordinal), layout: 'standard' })) },
			input: { earlierBoundary: 'visible', showLaterBoundary: true } });
		input.display = { ...input.display, window: { ...input.display.window!, interval: { after: 499, through: 500 } } };
		const model = build(input);
		const earlier = model.items.findIndex(item => item.kind === 'earlier-boundary');
		const later = model.items.findIndex(item => item.kind === 'later-boundary');
		expect(model.indexByRowId.get('view-1:40')).toBeLessThan(earlier);
		expect(model.indexByRowId.get('view-1:700')).toBeGreaterThan(later);
		for (const ordinal of [20, 40, 700, 900]) {
			const index = model.indexByRowId.get(`view-1:${ordinal}`)!;
			expect(model.items[index - 1].kind).toBe('retained-gap');
			expect(model.items[index + 1].kind).toBe('retained-gap');
		}
	});

	it('places retained members beyond the bounded child-page edges, not inside its completeness claim', () => {
		const group = displayGroup(1, 1000, 1000);
		const input = certifiedFeed([bash(20), bash(40), bash(500), bash(700), bash(900)], { items: [group], display: {
			protectedRows: [20, 40, 700, 900].map(ordinal => ({ certificate: displayCertificate(), detail: displayDetail(ordinal), layout: 'standard' })),
			expansions: [{ anchorOrdinal: 500, openedAt: 1, page: { certificate: displayCertificate(), base: group.base, fragment: group.fragment, ordinals: [500],
				earlier: { beforeOrdinal: 500, remaining: 499 }, later: { afterOrdinal: 500, remaining: 500 } } }],
		} });
		const model = build(input);
		const edges = model.items.flatMap((item, index) => item.kind === 'member-boundary' ? [index] : []);
		expect(model.indexByRowId.get('view-1:40')).toBeLessThan(edges[0]);
		expect(model.indexByRowId.get('view-1:500')).toBeGreaterThan(edges[0]);
		expect(model.indexByRowId.get('view-1:500')).toBeLessThan(edges[1]);
		expect(model.indexByRowId.get('view-1:700')).toBeGreaterThan(edges[1]);
	});

	it('keeps retained summary keys outside the certified interval with gaps and no fabricated members', () => {
		const group = displayGroup(1, 100, 100);
		const original = build(certifiedFeed([], { items: [group] })).items.find(item => item.kind === 'tool-group')!;
		const input = certifiedFeed([user(500)], { display: { protectedGroups: [{ certificate: displayCertificate(), descriptor: group }] },
			input: { earlierBoundary: 'visible' } });
		input.display = { ...input.display, window: { ...input.display.window!, interval: { after: 499, through: 500 } } };
		const model = build(input);
		const summary = model.items.findIndex(item => item.kind === 'tool-group');
		expect(model.items[summary]).toEqual({ ...original, retained: true });
		expect(model.items[summary - 1].kind).toBe('retained-gap');
		expect(model.items[summary + 1].kind).toBe('retained-gap');
		expect(summary).toBeLessThan(model.items.findIndex(item => item.kind === 'earlier-boundary'));
		expect(model.items.flatMap(item => item.kind === 'transcript' ? [item.item.id] : [])).toEqual(['view-1:500']);
	});

	it('uses server cut placements for permission and optimistic rows between group fragments', () => {
		const request = { ...permission('permission-1'), transcript: { transcriptViewId: 'view-1', afterOrdinal: 2 } };
		const input = certifiedFeed([], { items: [displayGroup(1, 2, 2), displayGroup(3, 4, 2)], input: { pendingPermissions: [request],
			overlays: [{ kind: 'message', id: 'optimistic:pending', message: new UserMessage('', 'Pending input') }],
			optimisticAfterOrdinals: new Map([['pending', 2]]),
		} });
		input.display = { ...input.display, window: { ...input.display.window!, cutPlacements: [
			{ id: 'permission:permission-1', placement: 'inline' }, { id: 'optimistic:pending', placement: 'inline' },
		] } };
		expect(build(input).items.slice(1, -1).map(item => item.kind)).toEqual(['tool-group', 'transcript', 'permission', 'tool-group']);
	});

	it('keeps distinct detached permission capabilities reachable without a prepared window', () => {
		const input = certifiedFeed([], { display: { window: null, phase: 'failed' }, input: { pendingPermissions: [permission('one'), permission('two')], reserveComposerCapSpace: true } });
		const model = build(input);
		expect(model.items.map(item => item.kind)).toEqual(['viewport-start-spacer', 'permission', 'permission', 'viewport-end-spacer']);
		expect(model.items[1]).toMatchObject({ leadingSpacing: true, spacingAfter: 'responsive-feed' });
		expect(model.items[2]).toMatchObject({ leadingSpacing: false, spacingAfter: 'none' });
		expect(new Set(model.items.map(item => item.key)).size).toBe(model.items.length);
		expect(estimateConversationFeedItemSize(model.items.at(-1))).toBe(56);
	});

	it('indexes canonical occurrences rather than reused tool IDs and keeps surface keys independent', () => {
		const input = certifiedFeed([bash(1), bash(2)]);
		const model = build(input), other = build({ ...input, surfaceIdentity: 'surface-2' });
		expect(model.targetByDomAnchorId.get('view-1:2')).toEqual({ index: 2, innerRowId: 'view-1:2' });
		expect(model.targetByDomAnchorId.has('tool-input-reused-tool-id')).toBe(false);
		expect(model.items[2].key).not.toBe(other.items[2].key);
		expect(other.indexByRowId.get('view-1:2')).toBe(2);
	});

	it('routes command output fragments to their exact canonical rows', () => {
		const model = build(certifiedFeed([1, 2].map(ordinal => displayRow(ordinal, new CommandOutputMessage('', 'command-1', 'stdout', 'plain', `Part ${ordinal}`, null, ordinal - 1)))));
		expect(model.indexByRowId.get('view-1:1')).toBe(1);
		expect(model.indexByRowId.get('view-1:2')).toBe(2);
	});

	it('retains established notice and presented-user geometry estimates', () => {
		const messages = [
			new UserMessage('', 'Ordinary'),
			new UserMessage('', 'Presented', undefined, undefined, { origin: 'cli', style: 'info' }),
			new TranscriptNoticeMessage('', 'Plain notice'),
			new TranscriptNoticeMessage('', 'Generic summary', { type: 'handoff-summary' }),
			new TranscriptNoticeMessage('', 'Generic message', { type: 'inter-agent-message-received', fromChatId: '1000000000000001' }),
			new TranscriptNoticeMessage('', 'Generic message', { type: 'inter-agent-message-outcome', results: [
				{ chatId: '1000000000000001', status: 'delivered' }, { chatId: '1000000000000002', status: 'failed', reason: 'target-not-found' },
				{ chatId: '1000000000000003', status: 'failed', reason: 'delivery-failed' },
			] }),
		];
		const model = build(certifiedFeed(messages.map((message, index) => displayRow(index + 1, message))));
		expect(model.items.slice(1, -1).map(estimateConversationFeedItemSize)).toEqual([124, 156, 64, 242, 242, 294]);
	});
});
