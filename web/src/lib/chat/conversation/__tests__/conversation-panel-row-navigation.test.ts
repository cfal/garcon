import { afterEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { AssistantMessage } from '$shared/chat-types';
import type { ChatHistoryResponse, CompleteChatHistoryResponse } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import { ConversationPanelRegistry } from '../conversation-panel-registry.svelte.js';

vi.mock('$lib/api/chats.js', () => ({ getChatMessages: vi.fn() }));
const chatId = '1000000000000001';
const target = { chatId, transcriptViewId: 'view-1', ordinal: 100 };
const row = (ordinal: number) => ({
	ordinal,
	message: new AssistantMessage('2026-01-01T00:00:00.000Z', `Synthetic row ${ordinal}`),
});
function page(): CompleteChatHistoryResponse {
	return {
		chatId,
		transcriptViewId: 'view-1',
		historyState: { kind: 'complete' },
		messages: [row(100)],
		lastOrdinal: 1000,
		pageOldestOrdinal: 100,
		pageNewestOrdinal: 100,
		nextBeforeOrdinal: 51,
		hasMore: true,
		limit: 50,
		resendCandidates: [],
	};
}
function snapshotPage(transcriptViewId = 'view-1'): CompleteChatHistoryResponse {
	return {
		...page(),
		transcriptViewId,
		messages: Array.from({ length: 50 }, (_, index) => row(951 + index)),
		pageOldestOrdinal: 951,
		pageNewestOrdinal: 1000,
		nextBeforeOrdinal: 951,
	};
}
function held<T>() {
	let release!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0)) fn();
	vi.resetAllMocks();
});
function fixture() {
	const cache = new ChatTranscriptCache({ limit: 50 });
	cache.replace(chatId, 'view-1', [row(1000)], 1000, 951);
	const registry = new ConversationPanelRegistry({
		cache,
		overlays: new ConversationTranscriptOverlayStore(),
		lifecycle: { forChat: () => new ConversationLifecycleState(), remove: () => {} },
		getComposerAnchorSurfaceId: () => 'chat-view:window-one',
		getSelectedChatId: () => chatId,
	});
	cleanup.push(() => registry.destroy());
	registry.reconcile([
		{
			surfaceId: 'chat-view:window-one',
			windowId: 'window-one',
			presentation: 'window-one',
			chatId,
			snapshotAdmission: 'admitted',
		},
	]);
	const panel = registry.panel('chat-view:window-one')!;
	const viewport = {
		isReady: () => true,
		isAtEnd: () => false,
		ownsScrollPosition: () => false,
		viewportPosition: () => ({
			logicalOffset: 100,
			distanceFromStart: 100,
			leadingContentReachable: true,
		}),
		scrollToStart: vi.fn(),
		scrollToEnd: vi.fn(),
		restoreInitialEnd: vi.fn(),
		scrollBy: vi.fn(),
		waitForLayout: vi.fn(async () => 'settled' as const),
		measureViewportFill: vi.fn(async () => 'underfilled' as const),
		restoreHiddenReadingPosition: vi.fn(async () => 'restored' as const),
		cancelPendingLayoutMutation: vi.fn(),
		cancelForUserIntent: vi.fn(() => 'cancelled' as const),
		setNativeScrollActivity: vi.fn(),
		scrollToTarget: vi.fn<ConversationViewportPort['scrollToTarget']>(async () => 'completed'),
	} satisfies ConversationViewportPort;
	let attachedViewport: ConversationViewportPort | null = null;
	panel.attachPresentation({
		getScrollContainer: () => null,
		getViewport: () => attachedViewport,
		getQueueContainer: () => undefined,
		captureRestoreTarget: () => null,
		closeTransients: () => {},
	});
	return {
		registry,
		panel,
		viewport,
		attach: () => {
			attachedViewport = viewport;
			panel.resumePendingRestore();
		},
	};
}

it('waits for the exact renderer viewport, supersedes bottom restore, and loads one page without autofill', async () => {
	const f = fixture();
	vi.mocked(getChatMessages).mockResolvedValue(page());
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	await tick();
	expect(getChatMessages).not.toHaveBeenCalled();
	f.attach();
	expect(await work).toBe('completed');
	expect(f.viewport.scrollToTarget).toHaveBeenCalledExactlyOnceWith(
		{ kind: 'row', id: 'view-1:100' },
		{ align: 'center' },
	);
	expect(f.viewport.scrollToEnd).not.toHaveBeenCalled();
	expect(f.viewport.measureViewportFill).not.toHaveBeenCalled();
	expect(getChatMessages).toHaveBeenCalledOnce();
});

it('retains reload identity if the view changes while the target page is held', async () => {
	const f = fixture();
	f.attach();
	const response = held<ChatHistoryResponse>();
	vi.mocked(getChatMessages).mockReturnValue(response.promise);
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
	f.panel.transcript.replaceGeneration(chatId, 'view-2', [row(100)], {
		lastOrdinal: 100,
		pageOldestOrdinal: 100,
		nextBeforeOrdinal: 51,
		hasMore: true,
	});
	response.release(page());
	expect(await work).toBe('view-changed');
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
});

it.each(['hide', 'interaction', 'supersede'] as const)(
	'cancels a held target page on %s without overwriting or scrolling',
	async (change) => {
		const f = fixture();
		f.attach();
		const response = held<ChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(response.promise).mockResolvedValue(page());
		const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
		await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
		if (change === 'hide') f.panel.prepareForHide();
		if (change === 'interaction') f.panel.prepareForInteractionLoss();
		if (change === 'supersede')
			expect(
				await f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true),
			).toBe('completed');
		response.release(page());
		expect(await work).toBe('cancelled');
		expect(f.viewport.scrollToTarget).toHaveBeenCalledTimes(change === 'supersede' ? 1 : 0);
		expect(vi.mocked(getChatMessages).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	},
);

it('aborts an in-progress viewport target without resetting another navigation', async () => {
	const f = fixture();
	f.attach();
	vi.mocked(getChatMessages).mockResolvedValue(page());
	const scroll = held<'completed'>();
	f.viewport.scrollToTarget.mockReturnValueOnce(scroll.promise);
	const abort = new AbortController();
	const work = f.panel.navigateToTranscriptRow(target, abort.signal, () => true);
	await vi.waitFor(() => expect(f.viewport.scrollToTarget).toHaveBeenCalledOnce());
	abort.abort();
	expect(f.viewport.cancelPendingLayoutMutation).toHaveBeenCalledOnce();
	scroll.release('completed');
	expect(await work).toBe('cancelled');
});

it('supersedes a saved-row restore before its first layout tick', async () => {
	const f = fixture();
	f.attach();
	vi.mocked(getChatMessages).mockResolvedValue(page());
	const restore = f.panel.restore({
		kind: 'row',
		transcriptViewId: 'view-1',
		ordinal: 1000,
		viewportOffset: 0,
	});
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	await restore;
	expect(await work).toBe('completed');
	expect(f.viewport.scrollToTarget).toHaveBeenCalledExactlyOnceWith(
		{ kind: 'row', id: 'view-1:100' },
		{ align: 'center' },
	);
});

it('cancels while the initial snapshot is held without waiting for its response', async () => {
	const f = fixture();
	f.attach();
	f.panel.transcript.transcriptCache.markStale(chatId);
	const snapshot = held<ChatHistoryResponse>();
	vi.mocked(getChatMessages).mockReturnValue(snapshot.promise);
	const restore = f.panel.restore(null);
	await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
	const abort = new AbortController();
	const work = f.panel.navigateToTranscriptRow(target, abort.signal, () => true);
	abort.abort();
	await expect(work).resolves.toBe('cancelled');
	expect(getChatMessages).toHaveBeenCalledOnce();
	snapshot.release({
		...page(),
		messages: [row(1)],
		pageOldestOrdinal: 1,
		lastOrdinal: 1,
		pageNewestOrdinal: 1,
		nextBeforeOrdinal: null,
		hasMore: false,
	});
	await restore;
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
});

it('navigates after a failed initial snapshot has been retried successfully', async () => {
	const f = fixture();
	f.attach();
	f.panel.transcript.transcriptCache.markStale(chatId);
	vi.mocked(getChatMessages).mockRejectedValueOnce(new Error('Synthetic snapshot failure'));
	await expect(f.panel.restore(null)).rejects.toThrow('Synthetic snapshot failure');
	vi.mocked(getChatMessages).mockResolvedValueOnce(snapshotPage()).mockResolvedValue(page());
	await expect(f.registry.loadChatSnapshot(chatId)).resolves.toBe(true);
	await expect(
		f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true),
	).resolves.toBe('completed');
	expect(f.viewport.scrollToTarget).toHaveBeenCalledOnce();
});

it('waits for a current reload snapshot and reports the replaced view', async () => {
	const f = fixture();
	f.attach();
	const snapshot = held<ChatHistoryResponse>();
	vi.mocked(getChatMessages).mockReturnValueOnce(snapshot.promise);
	const reload = f.registry.loadChatSnapshot(chatId);
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	let settled = false;
	void work.then(() => {
		settled = true;
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(settled).toBe(false);
	snapshot.release(snapshotPage('view-2'));
	await reload;
	expect(await work).toBe('view-changed');
	expect(getChatMessages).toHaveBeenCalledOnce();
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
});

it('waits through a purpose-qualified successor snapshot before loading its target', async () => {
	const f = fixture();
	f.attach();
	const first = held<ChatHistoryResponse>();
	const successor = held<ChatHistoryResponse>();
	vi.mocked(getChatMessages)
		.mockReturnValueOnce(first.promise)
		.mockReturnValueOnce(successor.promise)
		.mockResolvedValue(page());
	const background = f.registry.loadChatSnapshot(chatId);
	const activation = f.registry.loadChatSnapshot(chatId, { purpose: 'activation' });
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	first.release(snapshotPage());
	await background;
	await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledTimes(2));
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
	successor.release(snapshotPage());
	await activation;
	expect(await work).toBe('completed');
	expect(getChatMessages).toHaveBeenCalledTimes(3);
});

it.each(['view-1', 'view-2'])(
	'waits for a snapshot in %s that supersedes the target request',
	async (viewId) => {
		const f = fixture();
		f.attach();
		const targetPage = held<ChatHistoryResponse>();
		const snapshot = held<ChatHistoryResponse>();
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(targetPage.promise)
			.mockReturnValueOnce(snapshot.promise);
		const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
		await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
		const reload = f.registry.loadChatSnapshot(chatId);
		targetPage.release(page());
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
		snapshot.release(snapshotPage(viewId));
		await reload;
		expect(await work).toBe(viewId === 'view-2' ? 'view-changed' : 'unavailable');
		expect(getChatMessages).toHaveBeenCalledTimes(2);
	},
);

it.each(['completed', 'unavailable', 'view-changed'] as const)(
	'replaces a stale %s result when interaction is lost during the final snapshot checkpoint',
	async (result) => {
		const f = fixture();
		f.attach();
		vi.spyOn(f.panel.scroll, 'navigateToTranscriptRow').mockResolvedValue(result);
		const ownsNavigation = () => {
			queueMicrotask(() => f.panel.prepareForInteractionLoss());
			return true;
		};
		expect(
			await f.panel.navigateToTranscriptRow(target, new AbortController().signal, ownsNavigation),
		).toBe('cancelled');
	},
);
