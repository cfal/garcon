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

vi.mock('$lib/api/chats.js', () => ({ getChatMessages: vi.fn() }));

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
			pageOldestOrdinal: 1,
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
