import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import {
	ConversationPanelRegistry,
	type ConversationPanelDescriptor,
} from '../conversation-panel-registry.svelte.js';
import { CurrentConversationPanelTranscript } from '../current-conversation-panel-transcript.js';
import { ConversationClearController } from '../conversation-clear-controller.svelte.js';
import { clearChat } from '$lib/api/chat-clear.js';

vi.mock('$lib/api/chats.js', () => ({ getChatMessages: vi.fn() }));
vi.mock('$lib/api/chat-clear.js', () => ({ clearChat: vi.fn() }));

function entry(ordinal: number): TranscriptMessage {
	return {
		ordinal,
		message: new AssistantMessage('2026-01-01T00:00:00.000Z', `message-${ordinal}`),
	};
}

function presentation(
	windowId: `window-${string}`,
	chatId = 'chat-1',
): ConversationPanelDescriptor {
	return {
		surfaceId: `chat-view:${windowId}`,
		chatId,
		presentation: windowId,
		windowId,
		snapshotAdmission: 'admitted',
	};
}

function deferredPage(lastOrdinal = 2, transcriptViewId = 'view-1') {
	let resolve!: (page: Awaited<ReturnType<typeof getChatMessages>>) => void;
	vi.mocked(getChatMessages).mockReturnValueOnce(
		new Promise((done) => {
			resolve = done;
		}),
	);
	return () =>
		resolve({
			chatId: 'chat-1',
			historyState: { kind: 'complete' },
			transcriptViewId,
			messages: Array.from({ length: lastOrdinal }, (_, index) => entry(index + 1)),
			lastOrdinal,
			pageOldestOrdinal: lastOrdinal > 0 ? 1 : 0,
			pageNewestOrdinal: lastOrdinal,
			nextBeforeOrdinal: null,
			hasMore: false,
			limit: 50,
			resendCandidates: [],
		});
}

describe('CurrentConversationPanelTranscript activation handoff', () => {
	const cleanups: (() => void)[] = [];

	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
		vi.mocked(clearChat).mockReset();
	});

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	function fixture() {
		const cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 60_000 });
		cache.replace('chat-1', 'view-1', [entry(1)], 1, null);
		cache.replace('chat-2', 'view-other', [entry(10)], 10, null);
		let selectedChatId = 'chat-1';
		const lifecycles = new Map<string, ConversationLifecycleState>();
		const registry = new ConversationPanelRegistry({
			cache,
			overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: {
				forChat(chatId) {
					let lifecycle = lifecycles.get(chatId);
					if (!lifecycle) {
						lifecycle = new ConversationLifecycleState();
						lifecycle.setCurrentChatId(chatId);
						lifecycles.set(chatId, lifecycle);
					}
					return lifecycle;
				},
				remove: (chatId) => {
					lifecycles.delete(chatId);
				},
			},
			getComposerAnchorSurfaceId: () => 'chat-view:window-left',
			getSelectedChatId: () => selectedChatId,
		});
		const selected = new CurrentConversationPanelTranscript({
			panels: registry,
			getSelectedChatId: () => selectedChatId,
		});
		selected.activateChat('chat-1');
		cleanups.push(() => {
			registry.destroy();
			cache.flush();
		});
		return {
			cache,
			registry,
			selected,
			selectChat: (chatId: string) => {
				selectedChatId = chatId;
			},
		};
	}

	it.each([0, 1, 2])('recovers Clear without WS delivery across %i panels and an older activation', async (panelCount) => {
		const { cache, registry, selected } = fixture();
		registry.reconcile(['window-left', 'window-right'].slice(0, panelCount).map(windowId =>
			presentation(windowId as `window-${string}`)));
		selected.upsertOptimisticUserInput({ chatId: 'chat-1', clientMessageId: 'synthetic-input',
			content: 'Synthetic optimistic input', createdAt: '2026-01-01T00:00:00.000Z', delivery: 'pending' });
		selected.appendLocalNoticeForChat('chat-1', 'error', 'Synthetic old error');
		const resolveOld = deferredPage(2);
		const oldLoad = selected.loadMessages('chat-1', { purpose: 'activation' });
		const resolveCleared = deferredPage(0, 'view-cleared');
		const sessions = { quietRefreshChats: vi.fn(async () => {}) };
		const controller = new ConversationClearController({ chatState: selected, sessions,
			composerState: { draftRevision: () => 1, clearAfterSubmit: vi.fn() } });
		vi.mocked(clearChat).mockResolvedValue({ success: true, chatId: 'chat-1', transcriptViewId: 'view-cleared' });
		controller.request('chat-1', true);
		const clearing = controller.confirm();
		await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledTimes(2));
		resolveCleared();
		await clearing;
		resolveOld();
		await oldLoad;
		expect(cache.get('chat-1')?.transcriptViewId).toBe('view-cleared');
		expect(selected.chatMessages).toEqual([]);
		expect(registry.overlayFor('chat-1')?.optimisticInputs).toEqual([]);
		expect(selected.displayRows).toEqual([]);
		expect(sessions.quietRefreshChats).toHaveBeenCalledOnce();
		expect(controller.isOpen).toBe(false);
	});

	it.each(['failure', 'unmount'])('never restores cleared cached rows after recovery %s and a revisit', async (outcome) => {
		const { cache, registry, selected, selectChat } = fixture();
		registry.reconcile([presentation('window-left')]);
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof getChatMessages>>>();
		vi.mocked(getChatMessages).mockReturnValueOnce(pending.promise);
		const recovery = selected.recoverViewReplacement('chat-1', 'view-1');
		expect(cache.get('chat-1')).toBeNull();
		if (outcome === 'failure') {
			pending.reject(new Error('Synthetic recovery failure'));
			await expect(recovery).rejects.toThrow('Synthetic recovery failure');
		} else {
			selectChat('chat-2');
			registry.reconcile([presentation('window-left', 'chat-2')]);
			pending.resolve({ chatId: 'chat-1', historyState: { kind: 'complete' },
				transcriptViewId: 'view-cleared', messages: [], lastOrdinal: 1,
				pageOldestOrdinal: 0, pageNewestOrdinal: 0, nextBeforeOrdinal: null,
				hasMore: false, limit: 50, resendCandidates: [] });
			await recovery;
		}
		selectChat('chat-2');
		registry.reconcile([presentation('window-left', 'chat-2')]);
		const resolveReload = deferredPage(0, 'view-cleared');
		selectChat('chat-1');
		registry.reconcile([presentation('window-left')]);
		expect(selected.chatMessages).toEqual([]);
		resolveReload();
		await registry.loadChatSnapshot('chat-1');
	});

	it('preserves newer-view output and overlays when Clear acknowledgement is delayed', async () => {
		const { cache, registry, selected } = fixture();
		registry.reconcile([presentation('window-left')]);
		cache.replace('chat-1', 'view-later', [entry(5)], 5, null);
		registry.panel('chat-view:window-left')!.transcript.installCachedSnapshot('chat-1');
		selected.upsertOptimisticUserInput({ chatId: 'chat-1', clientMessageId: 'new-input',
			content: 'Synthetic newer input', createdAt: '2026-01-01T00:00:00.000Z', delivery: 'pending' });
		await selected.recoverViewReplacement('chat-1', 'view-1');
		expect(getChatMessages).not.toHaveBeenCalled();
		expect(selected.transcriptViewId).toBe('view-later');
		expect(selected.displayMessages.some(message =>
			message.type === 'user-message' && message.content === 'Synthetic newer input')).toBe(true);
	});

	it('recovers only the captured chat after selection changes', async () => {
		const { cache, registry, selected, selectChat } = fixture();
		selectChat('chat-2');
		registry.reconcile([presentation('window-left', 'chat-2'), presentation('window-right')]);
		const resolve = deferredPage(0, 'view-cleared');
		const recovery = selected.recoverViewReplacement('chat-1', 'view-1');
		resolve();
		await recovery;
		expect(cache.get('chat-1')?.messages).toEqual([]);
		expect(selected.transcriptViewId).toBe('view-other');
		expect(selected.chatMessages).toEqual([entry(10).message]);
	});

	it('evicts cleared history after its panel disappears and fallback activation changes chats', async () => {
		const { cache, registry, selected, selectChat } = fixture();
		registry.reconcile([presentation('window-left')]);
		const reply = Promise.withResolvers<Awaited<ReturnType<typeof clearChat>>>();
		vi.mocked(clearChat).mockReturnValueOnce(reply.promise);
		const controller = new ConversationClearController({ chatState: selected,
			sessions: { quietRefreshChats: vi.fn(async () => {}) },
			composerState: { draftRevision: () => 1, clearAfterSubmit: vi.fn() } });
		controller.request('chat-1', true);
		const clearing = controller.confirm();
		selectChat('chat-2');
		registry.reconcile([]);
		selected.activateChat('chat-2');
		controller.handleChatSwitch('chat-2');
		reply.resolve({ success: true, chatId: 'chat-1', transcriptViewId: 'view-cleared' });
		await clearing;
		expect(getChatMessages).not.toHaveBeenCalled();
		expect(cache.get('chat-1')).toBeNull();
		expect(selected.transcriptViewId).toBe('view-other');
		selectChat('chat-1');
		selected.activateChat('chat-1');
		expect(selected.chatMessages).toEqual([]);
	});

	it.each([1, 2])(
		'publishes a deferred activation to %i newly mounted panels',
		async (panelCount) => {
			const { cache, registry, selected } = fixture();
			const resolve = deferredPage();
			const loading = selected.loadMessages('chat-1', { purpose: 'activation' });
			registry.reconcile([
				presentation('window-left'),
				...(panelCount === 2 ? [presentation('window-right')] : []),
			]);
			for (const panel of registry.panelsForChat('chat-1'))
				expect(panel.transcript.lastOrdinal).toBe(1);
			resolve();
			expect(await loading).toEqual([entry(1).message, entry(2).message]);
			expect(cache.get('chat-1')?.lastOrdinal).toBe(2);
			for (const panel of registry.panelsForChat('chat-1')) {
				expect(panel.transcript.entries).toEqual(cache.get('chat-1')?.messages);
				expect(panel.transcript.lastOrdinal).toBe(2);
			}
			expect(getChatMessages).toHaveBeenCalledOnce();
		},
	);

	it.each([1, 2])('preserves the newer snapshot load for %i mounted panels', async (panelCount) => {
		const { cache, registry, selected } = fixture();
		cache.markStale('chat-1');
		const resolveFallback = deferredPage();
		const activation = selected.loadMessages('chat-1', { purpose: 'activation' });
		const resolveMounted = deferredPage(3);
		registry.reconcile([
			presentation('window-left'),
			...(panelCount === 2 ? [presentation('window-right')] : []),
		]);
		const mountedLoad = registry.loadChatSnapshot('chat-1');
		expect(selected.isLoadingMessages).toBe(true);
		expect(getChatMessages).toHaveBeenCalledTimes(2);

		resolveFallback();
		await activation;
		resolveMounted();
		await mountedLoad;

		expect(cache.get('chat-1')?.lastOrdinal).toBe(3);
		for (const panel of registry.panelsForChat('chat-1')) {
			expect(panel.transcript.lastOrdinal).toBe(3);
			expect(panel.transcript.entries).toEqual([entry(1), entry(2), entry(3)]);
			expect(panel.transcript.isLoadingMessages).toBe(false);
		}
	});

	it.each([1, 2])('retains a newer replacement snapshot in %i mounted panels', async (panelCount) => {
		const { cache, registry, selected } = fixture();
		cache.markStale('chat-1');
		const resolveFallback = deferredPage();
		const activation = selected.loadMessages('chat-1', { purpose: 'activation' });
		const resolveMounted = deferredPage(3, 'view-2');
		registry.reconcile([
			presentation('window-left'),
			...(panelCount === 2 ? [presentation('window-right')] : []),
		]);
		const mountedLoad = registry.loadChatSnapshot('chat-1');
		resolveMounted();
		await mountedLoad;
		expect(selected.transcriptViewId).toBe('view-2');

		resolveFallback();
		await activation;

		expect(cache.get('chat-1')?.transcriptViewId).toBe('view-2');
		for (const panel of registry.panelsForChat('chat-1')) {
			expect(panel.transcript.transcriptViewId).toBe('view-2');
			expect(panel.transcript.entries).toEqual([entry(1), entry(2), entry(3)]);
		}
	});

	it.each([1, 2])('keeps a fallback-established replacement in %i mounted panels', async (panelCount) => {
		const { cache, registry, selected } = fixture();
		cache.markStale('chat-1');
		const resolveFallback = deferredPage(2, 'view-2');
		const activation = selected.loadMessages('chat-1', { purpose: 'activation' });
		const resolveMounted = deferredPage(3);
		registry.reconcile([
			presentation('window-left'),
			...(panelCount === 2 ? [presentation('window-right')] : []),
		]);
		const mountedLoad = registry.loadChatSnapshot('chat-1');
		resolveFallback();
		await activation;
		expect(cache.get('chat-1')?.transcriptViewId).toBe('view-2');

		resolveMounted();
		await mountedLoad;

		expect(cache.get('chat-1')?.transcriptViewId).toBe('view-2');
		for (const panel of registry.panelsForChat('chat-1')) {
			expect(panel.transcript.transcriptViewId).toBe('view-2');
			expect(panel.transcript.entries).toEqual([entry(1), entry(2)]);
		}
	});

	it.each([0, 1, 2])('accepts same-view history after cold cache initialization with %i panels', async (panelCount) => {
		const { cache, registry, selected } = fixture();
		cache.remove('chat-1');
		selected.activateChat(null);
		selected.activateChat('chat-1');
		const resolve = deferredPage();
		const activation = selected.loadMessages('chat-1', { purpose: 'activation' });
		expect(selected.applyMessages('chat-1', 'view-1', [entry(1)], 1, 1)).toBe('applied');
		if (panelCount > 0) {
			registry.reconcile([
				presentation('window-left'),
				...(panelCount === 2 ? [presentation('window-right')] : []),
			]);
		}

		resolve();
		expect(await activation).toEqual([entry(1).message, entry(2).message]);
		expect(cache.get('chat-1')?.lastOrdinal).toBe(2);
		expect(selected.lastOrdinal).toBe(2);
		for (const panel of registry.panelsForChat('chat-1')) {
			expect(panel.transcript.entries).toEqual([entry(1), entry(2)]);
		}
		expect(getChatMessages).toHaveBeenCalledOnce();
	});

	it('publishes only to the captured chat after selection changes', async () => {
		const { cache, registry, selected, selectChat } = fixture();
		const resolve = deferredPage();
		const loading = selected.loadMessages('chat-1');
		selectChat('chat-2');
		registry.reconcile([presentation('window-left', 'chat-2'), presentation('window-right')]);
		resolve();
		expect(await loading).toEqual([entry(1).message, entry(2).message]);
		expect(registry.panel('chat-view:window-right')?.transcript.entries).toEqual(
			cache.get('chat-1')?.messages,
		);
		expect(selected.transcriptViewId).toBe('view-other');
		expect(selected.chatMessages).toEqual([entry(10).message]);
	});

	it('does not reinstall an invalidated response over a replacement view', async () => {
		const { cache, registry, selected } = fixture();
		const resolve = deferredPage();
		const loading = selected.loadMessages('chat-1');
		selected.discardChat('chat-1');
		cache.replace('chat-1', 'view-2', [entry(3)], 3, null);
		registry.reconcile([presentation('window-left')]);
		resolve();
		expect(await loading).toEqual([entry(3).message]);
		expect(selected.transcriptViewId).toBe('view-2');
		expect(selected.entries).toEqual(cache.get('chat-1')?.messages);
	});

	it('returns fallback messages when no panel has mounted', async () => {
		const { selected } = fixture();
		const resolve = deferredPage();
		const loading = selected.loadMessages('chat-1');
		resolve();
		expect(await loading).toEqual([entry(1).message, entry(2).message]);
		expect(selected.lastOrdinal).toBe(2);
	});
});
