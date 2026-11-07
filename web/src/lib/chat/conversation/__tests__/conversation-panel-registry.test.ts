import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserMessage } from '$shared/chat-types';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import { displayProfileKey } from '$shared/transcript-display-contract';
import { DisplayBodyStore } from '$lib/chat/transcript/display-body-store';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte';
import { displayOpen, displayRow, DISPLAY_TIME, mockDisplayApi } from '$lib/chat/transcript/__tests__/display-fixtures';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte';
import { ConversationPanelRegistry, type ConversationPanelDescriptor, type ConversationPanelPresentationPort } from '../conversation-panel-registry.svelte';
import { CurrentConversationPanelTranscript } from '../current-conversation-panel-transcript';

const left = 'chat-view:window-left', right = 'chat-view:window-right', third = 'chat-view:window-third';
const registries: ConversationPanelRegistry[] = [];
afterEach(() => { for (const registry of registries.splice(0)) registry.destroy(); vi.restoreAllMocks(); });
function presentation(surfaceId: typeof left | typeof right | typeof third, chatId = 'chat-1', snapshotAdmission: 'admitted' | 'deferred' = 'admitted'): ConversationPanelDescriptor {
	const windowId = surfaceId.slice('chat-view:'.length) as `window-${string}`;
	return { surfaceId, chatId, windowId, presentation: windowId, snapshotAdmission };
}
function fixture(options: { retainInactiveWindows?: () => boolean; getSelectedChatId?: () => string } = {}) {
	const api = mockDisplayApi([displayRow(1)]);
	const overlays = new ConversationTranscriptOverlayStore(), bodies = new DisplayBodyStore();
	const lifecycles = new Map<string, ConversationLifecycleState>();
	const onOpen = vi.fn();
	const registry = new ConversationPanelRegistry({ bodies, overlays, onOpen,
		lifecycle: {
			forChat(chatId) {
				let lifecycle = lifecycles.get(chatId);
				if (!lifecycle) { lifecycle = new ConversationLifecycleState(); lifecycle.setCurrentChatId(chatId); lifecycles.set(chatId, lifecycle); }
				return lifecycle;
			},
			remove: chatId => { lifecycles.delete(chatId); },
		},
		getComposerAnchorSurfaceId: () => left, getSelectedChatId: () => 'chat-1',
		...options,
	});
	registries.push(registry);
	return { api, registry, overlays, bodies, onOpen };
}
function port(target: ReturnType<ConversationPanelPresentationPort['captureRestoreTarget']>): ConversationPanelPresentationPort {
	return { getScrollContainer: () => null, getViewport: () => null, getQueueContainer: () => undefined,
		captureRestoreTarget: () => target, closeTransients: vi.fn() };
}
const pendingInput = { chatId: 'chat-1', clientMessageId: 'input-1', content: 'Synthetic input', createdAt: DISPLAY_TIME, delivery: 'pending' as const };

describe('display surface registry', () => {
	it.each([false, true])('retires old-view overlays when an open first reveals replacement, restarted=%s', async restarted => {
		const { registry, api, overlays } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		registry.upsertOptimisticInput('chat-1', pendingInput);
		registry.appendServerNotice('chat-1', 'error', 'Old-view error');
		registry.replaceResendCandidates('chat-1', [{ ordinal: 1, preview: 'Old prompt', timestamp: DISPLAY_TIME, attachmentCount: 0 }]);
		registry.excludeResendCandidate('chat-1', 1);
		if (restarted) registry.resetServerInstance('instance-2');
		api.replace([displayRow(1)], displayOpen('chat-1', 'replacement-view', 1, restarted ? 'instance-2' : 'instance-1'));
		await registry.loadChatSnapshot('chat-1');
		expect(overlays.forChat('chat-1').optimisticInputs).toEqual([]);
		expect(overlays.forChat('chat-1').notices).toEqual([]);
		expect(overlays.forChat('chat-1').excludedResendOrdinals).toEqual([]);
		expect(registry.panel(left)!.transcript.transcriptViewId).toBe('replacement-view');
	});
	it('clears status notices only on a new head while retaining unproven diagnostics', async () => {
		const { registry, overlays } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		registry.appendLocalNotice('chat-1', 'info', 'Synthetic status');
		registry.appendLocalNotice('chat-1', 'progress', 'Synthetic progress');
		registry.appendServerNotice('chat-1', 'warning', 'Synthetic warning');
		registry.appendServerNotice('chat-1', 'error', 'Synthetic error');
		registry.observeHead('chat-1', 'view-1', 1);
		expect(overlays.forChat('chat-1').notices).toHaveLength(4);
		registry.observeHead('chat-1', 'view-1', 2);
		expect(overlays.forChat('chat-1').notices.map(notice => notice.noticeType)).toEqual(['warning', 'error']);
		registry.appendLocalNotice('chat-1', 'info', 'New status');
		registry.observeHead('chat-1', 'view-1', 1);
		expect(overlays.forChat('chat-1').notices.at(-1)?.content).toBe('New status');
	});
	it('expires status notices on authoritative open advancement without a socket head', async () => {
		const { registry, api, overlays } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		for (const kind of ['info', 'progress', 'warning', 'error'] as const) registry.appendLocalNotice('chat-1', kind, `Synthetic ${kind}`);
		api.replace([displayRow(1), displayRow(2)]);
		await registry.loadChatSnapshot('chat-1');
		expect(overlays.forChat('chat-1').notices.map(notice => notice.noticeType)).toEqual(['warning', 'error']);
	});

	it.each(['before-parking', 'while-parked', 'stale'] as const)('preserves a per-chat reading target across surface reuse with eviction %s', async timing => {
		const { registry, api } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		const target = { kind: 'row' as const, transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -12 };
		registry.panel(left)!.attachPresentation(port(target));
		if (timing === 'before-parking') registry.upsertOptimisticInput('chat-1', pendingInput);
		api.replace([displayRow(1)], displayOpen('chat-2', 'view-2', 1));
		registry.prepareForReconcile([presentation(left, 'chat-2')]);
		registry.reconcile([presentation(left, 'chat-2')]);
		await registry.loadChatSnapshot('chat-2');
		if (timing === 'while-parked') registry.upsertOptimisticInput('chat-1', pendingInput);
		if (timing === 'stale') registry.markChatStale('chat-1');
		registry.prepareForReconcile([presentation(left)]);
		registry.reconcile([presentation(left)]);
		const restored = registry.panel(left)!;
		expect(restored.scroll.isPinnedToBottom).toBe(false);
		const jump = vi.spyOn(restored.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		restored.attachPresentation(port({ kind: 'end' }));
		await registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(jump).toHaveBeenCalledWith(
			{ chatId: 'chat-1', transcriptViewId: 'view-1', rowId: 'view-1:1' }, { viewportOffset: -12 }));
	});
	it('deduplicates source opens, not surface projection or leases', async () => {
		const { api, registry, bodies, onOpen } = fixture();
		registry.reconcile([presentation(left), presentation(right)]);
		expect(await registry.loadChatSnapshot('chat-1')).toBe(true);
		expect(api.open).toHaveBeenCalledOnce();
		expect(api.window).toHaveBeenCalledTimes(2);
		expect(onOpen).toHaveBeenCalledOnce();
		expect(bodies.count).toBe(1);
		const a = registry.panel(left)!, b = registry.panel(right)!;
		expect(a.transcript).not.toBe(b.transcript);
		a.transcript.isUserScrolledUp = true;
		expect(b.transcript.isUserScrolledUp).toBe(false);
		registry.reconcile([presentation(right)]);
		expect(b.transcript.entries).toHaveLength(1);
	});

	it('admits deferred surfaces only when a visible surface allows opening', async () => {
		const { api, registry } = fixture();
		registry.reconcile([presentation(left, 'chat-1', 'deferred')]);
		expect(await registry.loadChatSnapshot('chat-1')).toBe(false);
		expect(api.open).not.toHaveBeenCalled();
		registry.reconcile([presentation(left)]);
		expect(await registry.loadChatSnapshot('chat-1')).toBe(true);
		expect(api.open).toHaveBeenCalledOnce();
		expect(api.open.mock.calls[0][0].reason).toBe('activate');
	});

	it('distributes metadata and refreshes siblings without waiting for one layout gate', async () => {
		const { api, registry } = fixture();
		registry.reconcile([presentation(left), presentation(right)]);
		await registry.loadChatSnapshot('chat-1');
		const gate = Promise.withResolvers<'apply'>();
		registry.panel(left)!.transcript.setDisplayApplicationGate(() => gate.promise);
		api.replace([displayRow(1), displayRow(2)]);
		const loading = registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(registry.panel(right)!.transcript.loadedThroughOrdinal).toBe(2));
		expect(registry.panel(left)!.transcript.lastOrdinal).toBe(2);
		expect(registry.panel(left)!.transcript.loadedThroughOrdinal).toBe(1);
		gate.resolve('apply');
		expect(await loading).toBe(true);
	});

	it('initializes a surface that joins after open installation while a sibling projection is held', async () => {
		const { api, registry } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		const gate = Promise.withResolvers<'apply'>();
		registry.panel(left)!.transcript.setDisplayApplicationGate(() => gate.promise);
		const loading = registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(api.window).toHaveBeenCalledTimes(2));
		registry.reconcile([presentation(left), presentation(right)]);
		const joined = registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(registry.panel(right)!.transcript.loadedThroughOrdinal).toBe(1));
		gate.resolve('apply');
		expect(await loading).toBe(true);
		expect(await joined).toBe(true);
		expect(api.open).toHaveBeenCalledTimes(2);
	});

	it('preserves an activating open when the first socket confirms the same instance', async () => {
		const { api, registry } = fixture();
		const held = Promise.withResolvers<DisplayOpenResponse>();
		api.open.mockReturnValueOnce(held.promise);
		const loading = registry.loadChatSnapshot('chat-1', { purpose: 'activation' });
		registry.reconcile([presentation(left)]);
		await vi.waitFor(() => expect(api.open).toHaveBeenCalledOnce());
		registry.resetServerInstance('instance-1');
		held.resolve(displayOpen('chat-1', 'view-1', 1));
		expect(await loading).toBe(true);
		expect(registry.openSnapshot('chat-1')?.serverInstanceId).toBe('instance-1');
		expect(registry.panel(left)!.transcript.loadedThroughOrdinal).toBe(1);
		expect(api.open.mock.calls[0][0].reason).toBe('activate');
	});

	it('[TLV5-DISPLAY.07-WEB-UNIT-01] adopts an HTTP-discovered process change without invalidating its own open', async () => {
		const { api, registry, onOpen } = fixture();
		registry.reconcile([presentation(left), presentation(right)]);
		await registry.loadChatSnapshot('chat-1');
		api.replace([displayRow(1), displayRow(2)], displayOpen('chat-1', 'view-1', 2, 'instance-2'));
		expect(await registry.loadChatSnapshot('chat-1')).toBe(true);
		for (const panel of registry.panelsForChat('chat-1')) {
			expect(panel.transcript.serverInstanceId).toBe('instance-2');
			expect(panel.transcript.loadedThroughOrdinal).toBe(2);
		}
		expect(onOpen).toHaveBeenCalledTimes(2);
	});

	it.each([false, true])('rejects an old open after socket confirmation, previously confirmed: %s', async confirmed => {
		const { api, registry } = fixture();
		const old = Promise.withResolvers<DisplayOpenResponse>();
		api.open.mockReturnValueOnce(old.promise);
		registry.reconcile([presentation(left), presentation(right)]);
		const loading = registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(api.open).toHaveBeenCalledOnce());
		if (confirmed) registry.resetServerInstance('instance-1');
		registry.resetServerInstance('instance-2');
		api.replace([displayRow(1)], displayOpen('chat-1', 'view-1', 1, 'instance-2'));
		const next = registry.loadChatSnapshot('chat-1');
		old.resolve(displayOpen('chat-1', 'view-1', 1));
		expect(await loading).toBe(!confirmed);
		expect(await next).toBe(true);
		expect(registry.openSnapshot('chat-1')?.serverInstanceId).toBe('instance-2');
		for (const panel of registry.panelsForChat('chat-1')) expect(panel.transcript.serverInstanceId).toBe('instance-2');
	});

	it('cannot reinstall a retired snapshot after a sibling gate completes', async () => {
		const { api, registry } = fixture();
		registry.reconcile([presentation(left), presentation(right), presentation(third)]);
		await registry.loadChatSnapshot('chat-1');
		const gate = Promise.withResolvers<'apply'>();
		registry.panel(right)!.transcript.setDisplayApplicationGate(() => gate.promise);
		const loading = registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
		registry.resetServerInstance('instance-2');
		api.replace([displayRow(1)], displayOpen('chat-1', 'view-1', 1, 'instance-2'));
		const next = registry.loadChatSnapshot('chat-1');
		gate.resolve('apply');
		expect(await loading).toBe(false);
		expect(await next).toBe(true);
		for (const panel of registry.panelsForChat('chat-1')) expect(panel.transcript.serverInstanceId).toBe('instance-2');
	});

	it('does not move the known head backwards when an open finishes after live publication', async () => {
		const { api, registry } = fixture();
		registry.reconcile([presentation(left), presentation(right)]);
		await registry.loadChatSnapshot('chat-1');
		const held = Promise.withResolvers<DisplayOpenResponse>();
		api.open.mockReturnValueOnce(held.promise);
		const loading = registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
		registry.observeHead('chat-1', 'view-1', 3);
		held.resolve(displayOpen('chat-1', 'view-1', 2));
		await loading;
		expect(registry.knownHead('chat-1')?.lastOrdinal).toBe(3);
		registry.upsertOptimisticInput('chat-1', pendingInput);
		expect(registry.overlayFor('chat-1')?.optimisticAfterOrdinals.get('input-1')).toBe(3);
	});

	it('[TLV5-DISPLAY.06-WEB-UNIT-01] retains replacement-view acknowledged text on every surface until each projection catches up', async () => {
		const { api, registry } = fixture();
		registry.reconcile([presentation(left), presentation(right)]);
		await registry.loadChatSnapshot('chat-1');
		registry.upsertOptimisticInput('chat-1', pendingInput);
		const next = { ...displayOpen('chat-1', 'view-2', 2), submissions: [{ clientMessageId: 'input-1', ordinal: 2, outcome: 'committed' as const }] };
		api.replace([displayRow(1), displayRow(2, new UserMessage(DISPLAY_TIME, pendingInput.content, undefined, { clientMessageId: 'input-1' }))], next);
		const windowImpl = api.window.getMockImplementation()!;
		api.window.mockImplementation(async request => ({ kind: 'preparing', serverInstanceId: 'instance-1', chatId: 'chat-1', transcriptViewId: 'view-2',
			policyRevision: 1, profileKey: displayProfileKey(request.profile),
			bashRevision: 'patterns', sourceHead: 2, preparedThrough: 0, errorCode: null, retryAfterMs: 1500 }));
		await registry.loadChatSnapshot('chat-1');
		expect(registry.overlayFor('chat-1')?.optimisticInputs).toHaveLength(1);
		registry.reconcile([presentation(left), presentation(right), presentation(third)]);
		expect(registry.panel(third)!.transcript.visibleOptimisticInputs).toHaveLength(1);
		await registry.loadChatSnapshot('chat-1');
		expect(api.open.mock.calls.at(-1)?.[0].outstandingClientMessageIds).toEqual(['input-1']);
		const a = registry.panel(left)!.transcript, b = registry.panel(right)!.transcript;
		expect(a.visibleOptimisticInputs).toHaveLength(1);
		expect(b.visibleOptimisticInputs).toHaveLength(1);
		api.window.mockImplementation(windowImpl);
		await a.controller.refresh();
		expect(a.visibleOptimisticInputs).toHaveLength(0);
		expect(registry.overlayFor('chat-1')?.optimisticInputs).toHaveLength(0);
		expect(b.visibleOptimisticInputs).toHaveLength(1);
		expect(registry.panel(third)!.transcript.visibleOptimisticInputs).toHaveLength(1);
		await b.controller.refresh();
		expect(b.visibleOptimisticInputs).toHaveLength(0);
	});

	it('retains acknowledgements received before any surface exists', async () => {
		const { api, registry } = fixture();
		registry.upsertOptimisticInput('chat-1', pendingInput);
		registry.acknowledgeInput('chat-1', 'view-1', 'input-1', 2);
		expect(registry.overlayFor('chat-1')?.optimisticInputs[0].delivery).toBe('delivered');
		api.replace([displayRow(1), displayRow(2, new UserMessage(DISPLAY_TIME, pendingInput.content, undefined, { clientMessageId: 'input-1' }))],
			{ ...displayOpen('chat-1', 'view-1', 2), submissions: [{ clientMessageId: 'input-1', ordinal: 2 }] });
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		expect(api.open.mock.calls[0][0].outstandingClientMessageIds).toEqual(['input-1']);
		expect(registry.panel(left)!.transcript.visibleOptimisticInputs).toEqual([]);
	});

	it('[TLV5-DISPLAY.04-WEB-UNIT-02] parks bounded windows without replaying background bodies', async () => {
		const { api, registry } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		const first = registry.panel(left)!.transcript;
		registry.prepareForReconcile([]); registry.reconcile([]);
		const requests = api.window.mock.calls.length;
		registry.observeHead('chat-1', 'view-1', 50000);
		expect(first.lastOrdinal).toBe(50000);
		expect(first.loadedThroughOrdinal).toBe(1);
		expect(api.window).toHaveBeenCalledTimes(requests);
		registry.reconcile([presentation(left)]);
		expect(registry.panel(left)!.transcript).toBe(first);
	});

	it('evicts a parked window receiving new inputs and restores its saved reading target', async () => {
		const { api, registry } = fixture();
		registry.reconcile([presentation(left), presentation(right)]);
		await registry.loadChatSnapshot('chat-1');
		const first = registry.panel(left)!.transcript;
		const target = { kind: 'row' as const, transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -12 };
		registry.panel(left)!.attachPresentation(port(target));
		registry.prepareForReconcile([presentation(right)]);
		registry.reconcile([presentation(right)]);
		const requests = api.window.mock.calls.length;
		for (let index = 0; index < 33; index++) {
			const input = { ...pendingInput, clientMessageId: `input-${index}`, content: `Synthetic input ${index}` };
			registry.upsertOptimisticInput('chat-1', input);
			registry.acknowledgeInput('chat-1', 'view-1', input.clientMessageId, index + 2);
			api.replace([displayRow(1), displayRow(index + 2, new UserMessage(DISPLAY_TIME, input.content, undefined,
				{ clientMessageId: input.clientMessageId }))], displayOpen('chat-1', 'view-1', index + 2));
			await registry.panel(right)!.transcript.controller.refresh();
			await Promise.resolve();
		}
		expect(api.window.mock.calls.slice(requests).every(([request]) => request.anchor.kind === 'newest')).toBe(true);
		registry.reconcile([presentation(left), presentation(right)]);
		const restored = registry.panel(left)!;
		expect(restored.transcript).not.toBe(first);
		expect(restored.scroll.isPinnedToBottom).toBe(false);
		const jump = vi.spyOn(restored.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		restored.attachPresentation(port({ kind: 'end' }));
		await registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(jump).toHaveBeenCalledWith(
			{ chatId: 'chat-1', transcriptViewId: 'view-1', rowId: 'view-1:1' }, { viewportOffset: -12 }));
		expect(restored.transcript.visibleOptimisticInputs).toEqual([]);
		expect(restored.transcript.loadError).toBeNull();
	});

	it('gates a retained end restore before its refresh and ignores early geometry completion', async () => {
		const { api, registry } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		registry.prepareForReconcile([]); registry.reconcile([]);
		const held = Promise.withResolvers<DisplayOpenResponse>();
		api.open.mockReturnValueOnce(held.promise);
		registry.reconcile([presentation(left)]);
		const panel = registry.panel(left)!;
		expect(panel.scroll.isPreparingInitialScroll).toBe(true);
		panel.completeInitialBottomRestore();
		expect(panel.scroll.isPreparingInitialScroll).toBe(true);
		held.resolve(displayOpen('chat-1', 'view-1', 1));
		await registry.loadChatSnapshot('chat-1', { purpose: 'activation' });
		await Promise.resolve();
		panel.completeInitialBottomRestore();
		expect(panel.scroll.isPreparingInitialScroll).toBe(false);
	});

	it.each([
		{ retained: true, kind: 'row' }, { retained: false, kind: 'row' },
		{ retained: true, kind: 'group-summary' }, { retained: false, kind: 'group-summary' },
	] as const)('restores $kind around its saved ordinal (retained: $retained)', async ({ retained, kind }) => {
		const { api, registry } = fixture({ retainInactiveWindows: () => retained });
		api.replace(Array.from({ length: 200 }, (_, index) => displayRow(index + 1)));
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		const target = { kind, transcriptViewId: 'view-1', ordinal: 89, viewportOffset: -12 };
		registry.panel(left)!.attachPresentation(port(target));
		registry.prepareForReconcile([]); registry.reconcile([]);
		api.window.mockClear();
		const held = Promise.withResolvers<DisplayOpenResponse>();
		api.open.mockReturnValueOnce(held.promise);
		registry.reconcile([presentation(left)]);
		const panel = registry.panel(left)!;
		expect(panel.scroll.isPinnedToBottom).toBe(false);
		const positioned = Promise.withResolvers<'completed'>();
		const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockReturnValue(positioned.promise);
		panel.attachPresentation(port({ kind: 'end' }));
		panel.transcript.controller.setReadingAnchor(null, false);
		held.resolve(displayOpen('chat-1', 'view-1', 200));
		await registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(jump).toHaveBeenCalledOnce());
		panel.transcript.controller.trim(70, 70);
		expect(panel.transcript.entries.some(row => row.ordinal === 89)).toBe(true);
		panel.transcript.controller.setReadingAnchor(180, false);
		await panel.transcript.controller.refresh();
		expect(api.window.mock.calls.every(([request]) => request.anchor.kind === 'around' && request.anchor.ordinal === 89)).toBe(true);
		expect(jump).toHaveBeenCalledWith({ chatId: 'chat-1', transcriptViewId: 'view-1', rowId: 'view-1:89' },
			{ viewportOffset: -12, ...(kind === 'group-summary' ? { presentation: kind } : {}) });
		expect(api.resolve).not.toHaveBeenCalled();
		positioned.resolve('completed');
		await Promise.resolve(); await Promise.resolve();
		panel.transcript.controller.setReadingAnchor(110, false);
		await panel.transcript.controller.refresh();
		expect(api.window.mock.calls.at(-1)![0].anchor).toEqual({ kind: 'around', ordinal: 110 });
	});

	it('keeps focus and reading state on an existing duplicate destination during a surface move', async () => {
		const { registry } = fixture();
		registry.reconcile([presentation(left), presentation(right)]);
		await registry.loadChatSnapshot('chat-1');
		const destination = registry.panel(right)!;
		const target = { kind: 'row' as const, transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -31 };
		destination.attachPresentation(port(target));
		registry.prepareChatSurfaceTransfer({ sourceSurfaceId: left, destinationSurfaceId: right, chatId: 'chat-1' }).publish();
		registry.prepareForReconcile([presentation(right)]); registry.reconcile([presentation(right)]);
		expect(registry.panel(right)).toBe(destination);
		expect(destination.captureRestoreTarget()).toEqual(target);
	});

	it.each(['row', 'group-summary'] as const)('defers a %s restore until presentation attaches', async kind => {
		const { registry } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		const panel = registry.panel(left)!;
		const jump = vi.spyOn(panel.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		await panel.restore({ kind, transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -3 });
		expect(jump).not.toHaveBeenCalled();
		panel.attachPresentation(port({ kind: 'end' }));
		await vi.waitFor(() => expect(jump).toHaveBeenCalledOnce());
		expect(jump).toHaveBeenCalledWith({ chatId: 'chat-1', transcriptViewId: 'view-1', rowId: 'view-1:1' },
			{ viewportOffset: -3, ...(kind === 'group-summary' ? { presentation: kind } : {}) });
	});

	it('does not let an unmounted fallback invalidate mounted body leases', async () => {
		let selected = 'chat-1';
		const { registry, api, bodies } = fixture({ getSelectedChatId: () => selected });
		registry.reconcile([presentation(right)]);
		await registry.loadChatSnapshot('chat-1');
		selected = 'chat-2';
		const facade = new CurrentConversationPanelTranscript({ panels: registry, getSelectedChatId: () => selected });
		api.replace([displayRow(1)], displayOpen('chat-2', 'other-view', 1));
		await facade.loadMessages('chat-2');
		expect(api.open).toHaveBeenCalledTimes(2);
		expect(registry.openSnapshot('chat-2')?.transcriptViewId).toBe('other-view');
		expect(bodies.count).toBe(1);
		expect(registry.panel(right)!.transcript.chatMessages).toHaveLength(1);
		facade.discardChat('chat-2');
	});

	it.each([false, true])('transfers a retained window and reading target, parked=%s', async parked => {
		const { registry, bodies } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		const transcript = registry.panel(left)!.transcript;
		const target = { kind: 'row' as const, transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -12 };
		registry.panel(left)!.attachPresentation(port(target));
		if (parked) { registry.prepareForReconcile([]); registry.reconcile([]); }
		registry.prepareChatSurfaceTransfer({ sourceSurfaceId: left, destinationSurfaceId: right, chatId: 'chat-1' }).publish();
		registry.prepareForReconcile([presentation(right)]);
		registry.reconcile([presentation(right)]);
		const destination = registry.panel(right)!;
		expect(destination.transcript).toBe(transcript);
		expect(destination.scroll.isPinnedToBottom).toBe(false);
		const jump = vi.spyOn(destination.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		destination.attachPresentation(port({ kind: 'end' }));
		await registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(jump).toHaveBeenCalledWith(
			{ chatId: 'chat-1', transcriptViewId: 'view-1', rowId: 'view-1:1' }, { viewportOffset: -12 }));
		expect(bodies.count).toBe(1);
		expect(registry.panel(left)).toBeNull();
	});

	it('rolls back an unpublished move without transferring the source window', async () => {
		const { registry } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		const source = registry.panel(left)!;
		const transfer = registry.prepareChatSurfaceTransfer({ sourceSurfaceId: left, destinationSurfaceId: right, chatId: 'chat-1' });
		transfer.publish(); transfer.rollback();
		registry.reconcile([presentation(left), presentation(right)]);
		await registry.loadChatSnapshot('chat-1');
		expect(registry.panel(left)).toBe(source);
		expect(registry.panel(right)!.transcript).not.toBe(source.transcript);
	});

	it('transfers and consumes a saved reading target after budget eviction of its parked window', async () => {
		const { registry, api, bodies } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		const original = registry.panel(left)!.transcript;
		const target = { kind: 'row' as const, transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -12 };
		registry.panel(left)!.attachPresentation(port(target));
		for (let index = 2; index <= 6; index++) {
			const chatId = `chat-${index}`;
			api.replace([displayRow(1)], displayOpen(chatId, 'view-1', 1));
			registry.prepareForReconcile([presentation(left, chatId)]);
			registry.reconcile([presentation(left, chatId)]);
			await registry.loadChatSnapshot(chatId);
		}
		expect(bodies.usage(original.controller).count).toBe(0);
		registry.prepareChatSurfaceTransfer({ sourceSurfaceId: left, destinationSurfaceId: right, chatId: 'chat-1' }).publish();
		registry.prepareForReconcile([presentation(left, 'chat-6'), presentation(right)]);
		registry.reconcile([presentation(left, 'chat-6'), presentation(right)]);
		const destination = registry.panel(right)!;
		expect(destination.transcript).not.toBe(original);
		expect(destination.scroll.isPinnedToBottom).toBe(false);
		const jump = vi.spyOn(destination.scroll, 'jumpToMessageRow').mockResolvedValue('completed');
		destination.attachPresentation(port({ kind: 'end' }));
		await registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(jump).toHaveBeenCalledWith(
			{ chatId: 'chat-1', transcriptViewId: 'view-1', rowId: 'view-1:1' }, { viewportOffset: -12 }));
		registry.prepareForReconcile([presentation(left), presentation(right)]);
		registry.reconcile([presentation(left), presentation(right)]);
		expect(registry.panel(left)!.scroll.isPinnedToBottom).toBe(true);
		await registry.loadChatSnapshot('chat-1');
	});

	it('prunes a permanently removed surface and its parked leases and reading target', async () => {
		const { registry, bodies } = fixture();
		registry.reconcile([presentation(left)]);
		await registry.loadChatSnapshot('chat-1');
		const transcript = registry.panel(left)!.transcript;
		registry.panel(left)!.attachPresentation(port({ kind: 'row', transcriptViewId: 'view-1', ordinal: 1, viewportOffset: -12 }));
		registry.prepareForReconcile([]); registry.reconcile([]);
		registry.pruneRemovedSurfaces(new Set());
		expect(bodies.count).toBe(0);
		registry.reconcile([presentation(left)]);
		expect(registry.panel(left)!.transcript).not.toBe(transcript);
		expect(registry.panel(left)!.scroll.isPinnedToBottom).toBe(true);
	});

	it('drops pending publication and parked state after chat deletion', async () => {
		const { api, registry } = fixture();
		const held = Promise.withResolvers<DisplayOpenResponse>();
		api.open.mockReturnValueOnce(held.promise);
		registry.reconcile([presentation(left)]);
		const loading = registry.loadChatSnapshot('chat-1');
		await vi.waitFor(() => expect(api.open).toHaveBeenCalledOnce());
		registry.removeChat('chat-1');
		held.resolve(displayOpen('chat-1', 'view-1', 1));
		expect(await loading).toBe(false);
		expect(registry.panel(left)).toBeNull();
		expect(registry.openSnapshot('chat-1')).toBeNull();
	});
});
