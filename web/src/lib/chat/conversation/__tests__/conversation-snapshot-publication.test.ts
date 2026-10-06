import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage, ThinkingMessage, UserMessage } from '$shared/chat-types';
import type { CompleteChatHistoryResponse } from '$shared/chat-view';
import { getChatMessages, type ChatMessagesRequest } from '$lib/api/chats.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import { ConversationPanelRegistry, type ConversationPanelDescriptor } from '../conversation-panel-registry.svelte.js';

vi.mock('$lib/api/chats.js', () => ({ getChatMessages: vi.fn() }));
const row = (ordinal: number) => ({ ordinal, message: new AssistantMessage('', `Synthetic row ${ordinal}`) });
const input = { chatId: 'chat-1', clientMessageId: 'input-1', content: 'Synthetic input', createdAt: '', delivery: 'pending' as const };
const echo = (ordinal: number) => ({ ordinal, message: new UserMessage('', input.content, undefined, { clientMessageId: input.clientMessageId }) });
const panels = ['left', 'right'].map((side): ConversationPanelDescriptor => ({
	chatId: 'chat-1', surfaceId: `chat-view:window-${side}`, windowId: `window-${side}`,
	presentation: `window-${side}`, snapshotAdmission: 'admitted',
}));

function response(request: ChatMessagesRequest, lastOrdinal: number): CompleteChatHistoryResponse {
	const limit = request.limit ?? 50;
	const newest = Math.min(request.beforeOrdinal ?? lastOrdinal + 1, lastOrdinal + 1) - 1;
	const oldest = Math.max(1, newest - limit + 1);
	return {
		chatId: 'chat-1', transcriptViewId: 'view-1', limit, lastOrdinal,
		messages: Array.from({ length: newest - oldest + 1 }, (_, index) => row(oldest + index)),
		pageOldestOrdinal: oldest, pageNewestOrdinal: newest,
		nextBeforeOrdinal: oldest > 1 ? oldest : null, hasMore: oldest > 1,
		historyState: { kind: 'complete' }, resendCandidates: [],
	};
}

function fixture(loadTranscriptSnapshot?: ConstructorParameters<typeof ConversationPanelRegistry>[0]['loadTranscriptSnapshot']) {
	const cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 60_000 });
	const overlays = new ConversationTranscriptOverlayStore();
	const lifecycle = new ConversationLifecycleState();
	lifecycle.setCurrentChatId('chat-1');
	const registry = new ConversationPanelRegistry({
		cache, overlays, lifecycle: { forChat: () => lifecycle, remove: () => {} },
		getComposerAnchorSurfaceId: () => null, getSelectedChatId: () => null,
		retainInactiveWindows: () => true, loadTranscriptSnapshot,
	});
	return { cache, overlays, registry };
}

describe('shared snapshot publication', () => {
	beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });

	it('retries a peer installation after its old-view snapshot buffer rejects the replacement', async () => {
		const { cache, registry, overlays } = fixture(async (transcript, chatId) => {
			expect(transcript.setFromPage(chatId, {
				...response({ chatId, limit: 50 }, 1), transcriptViewId: 'view-2', messages: [echo(1)],
			}, transcript.beginSnapshotLoad())).toBe('applied');
		});
		cache.replace('chat-1', 'view-1', [row(1)], 1, null);
		registry.reconcile(panels);
		const left = registry.panel(panels[0].surfaceId)!.transcript;
		const right = registry.panel(panels[1].surfaceId)!.transcript;
		registry.upsertOptimisticInput('chat-1', input);
		right.beginSnapshotLoad();
		registry.applyCommittedBatch({
			chatId: 'chat-1', transcriptViewId: 'view-1', messages: [row(2)],
			firstOrdinal: 2, lastOrdinal: 2, resendCandidates: [], noticeRevision: 0,
		});
		const install = vi.spyOn(right, 'installCachedSnapshot');
		const settle = overlays.settleSnapshot.bind(overlays);
		vi.spyOn(overlays, 'settleSnapshot').mockImplementation((...args) => {
			for (const transcript of [left, right]) expect(transcript.transcriptViewId).toBe('view-2');
			return settle(...args);
		});
		await expect(registry.loadChatSnapshot('chat-1')).resolves.toBe(true);
		expect(install).toHaveBeenCalledTimes(2);
		expect(cache.readAppliedCursor('chat-1')?.transcriptViewId).toBe('view-2');
		expect(right.entries).toEqual([echo(1)]);
		expect(overlays.forChat('chat-1').optimisticInputs).toEqual([]);
		registry.destroy(); cache.flush();
	});

	it('fails publication without settling inputs when a peer rejects both installation attempts', async () => {
		const { cache, registry, overlays } = fixture(async (transcript, chatId) => {
			transcript.setFromPage(chatId, {
				...response({ chatId, limit: 50 }, 2), messages: [row(1), echo(2)],
			}, transcript.beginSnapshotLoad());
		});
		cache.replace('chat-1', 'view-1', [row(1)], 1, null);
		registry.reconcile(panels);
		registry.upsertOptimisticInput('chat-1', input);
		const right = registry.panel(panels[1].surfaceId)!.transcript;
		const install = vi.spyOn(right, 'installCachedSnapshot').mockReturnValue('gap-detected');
		const settle = vi.spyOn(overlays, 'settleSnapshot');
		await expect(registry.loadChatSnapshot('chat-1')).rejects.toThrow('Transcript snapshot could not be published');
		expect(install).toHaveBeenCalledTimes(2);
		expect(settle).not.toHaveBeenCalled();
		expect(overlays.forChat('chat-1').optimisticInputs).toHaveLength(1);
		expect(cache.readAppliedCursor('chat-1')?.stale).toBe(true);
		registry.destroy(); cache.flush();
	});

	it('settles replay-overflow echoes omitted from a latest-window snapshot after failed recovery', async () => {
		const { cache, registry, overlays } = fixture();
		cache.replace('chat-1', 'view-1', [row(100)], 100, 51);
		registry.reconcile(panels);
		const left = registry.panel(panels[0].surfaceId)!.transcript;
		const right = registry.panel(panels[1].surfaceId)!.transcript;
		registry.upsertOptimisticInput('chat-1', input);
		const token = registry.beginReconnectReplay('chat-1', 'view-1');
		const batch = { chatId: 'chat-1', transcriptViewId: 'view-1', firstOrdinal: 101, lastOrdinal: 101, messages: [echo(101)], resendCandidates: [], noticeRevision: 0 };
		registry.applyCommittedBatch(batch);
		expect(registry.applyCommittedBatch({ ...batch, firstOrdinal: 102, lastOrdinal: 1200, messages: [] }).kind).toBe('chat-recovery-required');
		registry.abortReconnectReplay(token, 'chat-1');
		vi.mocked(getChatMessages).mockRejectedValueOnce(new Error('Synthetic recovery failure'));
		await expect(registry.loadChatSnapshot('chat-1')).rejects.toThrow('Synthetic recovery failure');
		expect(overlays.forChat('chat-1').optimisticInputs).toHaveLength(1);
		vi.mocked(getChatMessages).mockImplementation(async (request) => response(request, 1200));
		await expect(left.navigateToWindow('chat-1', 'initial')).resolves.toBe('loaded');
		await expect(left.navigateToWindow('chat-1', 'latest')).resolves.toBe('loaded');
		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(1200);
		expect(overlays.forChat('chat-1').optimisticInputs).toEqual([]);
		for (const transcript of [left, right]) expect(transcript.displayRows.some((item) => item.id.startsWith('optimistic:'))).toBe(false);
		registry.destroy(); cache.flush();
	});

	it.each([false, true])('publishes bounded snapshot continuation to a peer with parked=%s', async (parked) => {
		const { cache, registry } = fixture();
		const thought = { ordinal: 10_000, message: new ThinkingMessage('', 'Synthetic hidden reasoning') };
		cache.replace('chat-1', 'view-1', [thought], 10_000, 10_000);
		registry.reconcile(panels);
		const left = registry.panel(panels[0].surfaceId)!.transcript;
		const right = registry.panel(panels[1].surfaceId)!.transcript;
		if (parked) { registry.prepareForReconcile([panels[0]]); registry.reconcile([panels[0]]); }
		vi.mocked(getChatMessages).mockImplementation(async (request) => {
			const page = response(request, 10_000);
			return { ...page, messages: page.pageNewestOrdinal === 10_000 ? [thought] : [], pageOldestOrdinal: page.pageNewestOrdinal === 10_000 ? 10_000 : 0 };
		});
		await expect(registry.loadChatSnapshot('chat-1')).resolves.toBe(true);
		expect(getChatMessages).toHaveBeenCalledTimes(10);
		for (const transcript of [left, right]) {
			expect(transcript.nextBeforeOrdinal).toBe(9510);
			expect(transcript.pageStates.earlier.status).toBe('bounded');
			expect(transcript.installCachedSnapshot('chat-1')).toBe('applied');
			expect(transcript.pageStates.earlier.status).toBe('bounded');
		}
		registry.destroy(); cache.flush();
	});

	it.each([false, true])('publishes the accepted boundary and known head from a disjoint loader with parked=%s', async (parked) => {
		const { cache, registry } = fixture();
		const tail = row(10_000);
		cache.replace('chat-1', 'view-1', [tail], 10_000, 10_000);
		registry.reconcile(panels);
		const left = registry.panel(panels[0].surfaceId)!.transcript;
		const right = registry.panel(panels[1].surfaceId)!.transcript;
		vi.mocked(getChatMessages).mockImplementation(async (request) => response(request, 10_000));
		await left.navigateToWindow('chat-1', 'initial');
		expect(left.nextBeforeOrdinal).toBeNull();
		if (parked) { registry.prepareForReconcile([panels[0]]); registry.reconcile([panels[0]]); }
		vi.mocked(getChatMessages).mockImplementation(async (request) => {
			const page = response(request, request.beforeOrdinal === undefined ? 10_000 : 10_001);
			return { ...page, messages: page.pageNewestOrdinal === 10_000 ? [tail] : [], pageOldestOrdinal: page.pageNewestOrdinal === 10_000 ? 10_000 : 0 };
		});
		await expect(registry.loadChatSnapshot('chat-1')).resolves.toBe(true);
		expect(left.nextBeforeOrdinal).toBeNull();
		expect(left.pageStates.earlier.status).toBe('idle');
		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(10_000);
		expect(right.nextBeforeOrdinal).toBe(9510);
		expect(right.pageStates.earlier.status).toBe('bounded');
		for (const transcript of [left, right]) {
			expect(transcript.lastOrdinal).toBe(10_001);
			expect(transcript.hasLaterMessages).toBe(true);
		}
		expect(right.loadedThroughOrdinal).toBe(10_000);
		registry.reconcile(panels);
		expect(registry.panel(panels[1].surfaceId)!.transcript).toBe(right);
		registry.prepareForReconcile([panels[0]]);
		registry.reconcile([panels[0]]);
		expect(registry.hasInactiveWindow('chat-1')).toBe(true);
		registry.reconcile(panels);
		expect(registry.panel(panels[1].surfaceId)!.transcript).toBe(right);
		expect(right.lastOrdinal).toBe(10_001);
		expect(right.hasLaterMessages).toBe(true);
		expect(right.pageStates.earlier.status).toBe('bounded');
		registry.destroy(); cache.flush();
	});

	it.each(['idle', 'bounded'] as const)('retains an unchanged deeper %s boundary across a bounded refresh', async (status) => {
		const { cache, registry } = fixture();
		cache.replace('chat-1', 'view-1', [row(10_000)], 10_000, 9451);
		registry.reconcile([panels[0]]);
		const transcript = registry.panel(panels[0].surfaceId)!.transcript;
		transcript.pageStates.earlier = { status, error: null };
		vi.mocked(getChatMessages).mockImplementation(async (request) => ({
			...response(request, 10_000), messages: [], pageOldestOrdinal: 0,
		}));
		await registry.loadChatSnapshot('chat-1');
		expect(getChatMessages).toHaveBeenCalledTimes(10);
		expect(transcript.nextBeforeOrdinal).toBe(9451);
		expect(transcript.pageStates.earlier.status).toBe(status);
		registry.destroy(); cache.flush();
	});

	it('preserves deeper cache coverage when a latest scan learns a newer head after its first page', async () => {
		const { cache, registry } = fixture();
		cache.replace('chat-1', 'view-1', [], 10_000, 6001);
		registry.reconcile([panels[0]]);
		const transcript = registry.panel(panels[0].surfaceId)!.transcript;
		vi.mocked(getChatMessages).mockImplementation(async (request) => response(request, 10_000));
		await transcript.navigateToWindow('chat-1', 'initial');
		vi.mocked(getChatMessages).mockImplementation(async (request) => ({
			...response(request, request.beforeOrdinal === undefined ? 10_000 : 10_001),
			messages: [], pageOldestOrdinal: 0,
		}));
		await expect(transcript.navigateToWindow('chat-1', 'latest')).resolves.toBe('loaded');
		expect(transcript.nextBeforeOrdinal).toBe(6001);
		expect(transcript.loadedThroughOrdinal).toBe(10_000);
		expect(transcript.lastOrdinal).toBe(10_001);
		expect(transcript.hasLaterMessages).toBe(true);
		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(10_000);
		registry.destroy(); cache.flush();
	});

	it('preserves an in-flight manual continuation when a same-cursor snapshot cancels its request', async () => {
		const { cache, registry } = fixture();
		cache.replace('chat-1', 'view-1', [row(100)], 100, 51);
		registry.reconcile([panels[0]]);
		const transcript = registry.panel(panels[0].surfaceId)!.transcript;
		transcript.pageStates.earlier = { status: 'bounded', error: null };
		vi.mocked(getChatMessages).mockImplementation((_request, options) => new Promise((_resolve, reject) => {
			options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
		}));
		const loading = transcript.loadEarlierPage('chat-1');
		expect(transcript.pageStates.earlier).toEqual({ status: 'loading', error: null, continuation: 'manual' });
		expect(transcript.installCachedSnapshot('chat-1')).toBe('applied');
		await expect(loading).resolves.toBe('invalidated');
		expect(transcript.nextBeforeOrdinal).toBe(51);
		expect(transcript.pageStates.earlier.status).toBe('bounded');
		registry.destroy(); cache.flush();
	});

	it.each(['published', 'pending'] as const)('clears the %s bounded later boundary when ordered replay reaches the known head', async (publication) => {
		const { cache, registry } = fixture();
		cache.replace('chat-1', 'view-1', [row(100)], 100, 51);
		registry.reconcile([panels[0]]);
		const transcript = registry.panel(panels[0].surfaceId)!.transcript;
		vi.mocked(getChatMessages).mockImplementation(async (request) => ({
			...response(request, 1000), messages: [], pageOldestOrdinal: 0,
		}));
		await transcript.loadEarlierPage('chat-1');
		let release!: () => void;
		let atGate!: () => void;
		const waiting = new Promise<void>((resolve) => { atGate = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const work = transcript.loadLaterPage('chat-1', {
			applicationGate: async () => { atGate(); await gate; return 'apply'; },
		});
		await waiting;
		if (publication === 'published') {
			release();
			await expect(work).resolves.toBe('bounded');
			expect(transcript.loadedThroughOrdinal).toBe(600);
		}
		const token = registry.beginReconnectReplay('chat-1', 'view-1');
		for (let first = 101; first <= 1000; first += 200) {
			expect(registry.applyReconnectReplayPage(token, 'chat-1', {
				transcriptViewId: 'view-1', messages: [], firstOrdinal: first,
				lastOrdinal: Math.min(first + 199, 1000), resendCandidates: [], noticeRevision: 0,
			})).toBe('applied');
		}
		expect(registry.finishReconnectReplay(token, 'chat-1')).toBe('applied');
		if (publication === 'pending') {
			expect(transcript.hasLaterMessages).toBe(false);
			release();
			await expect(work).resolves.toBe('exhausted');
		}
		expect(transcript.loadedThroughOrdinal).toBe(1000);
		expect(transcript.hasLaterMessages).toBe(false);
		expect(transcript.pageStates.later.status).toBe('idle');
		registry.destroy(); cache.flush();
	});

	it('advances each panel clock as soon as a no-change snapshot confirms delivery', async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const { cache, registry, overlays } = fixture(async (transcript, chatId) => {
			transcript.setFromPage(chatId, { ...response({ chatId, limit: 50 }, 1), messages: [echo(1)] }, transcript.beginSnapshotLoad());
			await pending;
		});
		cache.replace('chat-1', 'view-1', [echo(1)], 1, null);
		registry.reconcile(panels);
		registry.upsertOptimisticInput('chat-1', input);
		const transcripts = panels.map((panel) => registry.panel(panel.surfaceId)!.transcript);
		const revisions = transcripts.map((transcript) => transcript.feedMutationClock.dataRevision);
		const work = registry.loadChatSnapshot('chat-1');
		expect(overlays.forChat('chat-1').optimisticInputs[0]?.delivery).toBe('delivered');
		transcripts.forEach((transcript, index) => expect(transcript.feedMutationClock.dataRevision).toBeGreaterThan(revisions[index]));
		release();
		await work;
		registry.destroy(); cache.flush();
	});
});
