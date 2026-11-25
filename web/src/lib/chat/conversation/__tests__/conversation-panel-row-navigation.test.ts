import { seedTranscript } from '$lib/chat/transcript/__tests__/transcript-fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { AssistantMessage } from '$shared/chat-types';
import { emptyChatExecutionControlState } from '$shared/chat-execution-control';
import type { ChatHistoryResponse, CompleteChatHistoryResponse } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import type { ConversationPanelPresentationPort } from '../conversation-panel-registration.js';
import { ConversationPanelRegistry } from '../conversation-panel-registry.svelte.js';

vi.mock('$lib/api/chats.js', () => ({ getChatMessages: vi.fn() }));
const chatId = '1000000000000001';
const target = { chatId, transcriptViewId: 'view-1', ordinal: 100 };
const readingTarget = { kind: 'row', transcriptViewId: 'view-1', ordinal: 1000, viewportOffset: -8 } as const;
const windowPanel = {
	surfaceId: 'chat-view:window-one',
	windowId: 'window-one',
	presentation: 'window-one',
	chatId,
	snapshotAdmission: 'admitted',
} as const;
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
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, release: resolve };
}

function pendingSeek() {
	const started = held<void>();
	const result = held<'cancelled'>();
	return {
		started: started.promise,
		start() {
			started.release();
			return result.promise;
		},
		cancel: () => result.release('cancelled'),
	};
}

function presentationPort(
	getViewport: ConversationPanelPresentationPort['getViewport'],
): ConversationPanelPresentationPort {
	return {
		getScrollContainer: () => null,
		getViewport,
		getQueueContainer: () => undefined,
		captureRestoreTarget: () => null,
		closeTransients: () => {},
		prepareForHide: () => {},
	};
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
	registry.reconcile([windowPanel]);
	const panel = registry.panel(windowPanel.surfaceId)!;
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
		measureViewportFill: vi.fn<ConversationViewportPort['measureViewportFill']>(async () => 'underfilled'),
		readViewportFill: vi.fn<ConversationViewportPort['readViewportFill']>(() => 'underfilled'),
		onNextMeasurement: vi.fn(() => () => {}),
		restoreHiddenReadingPosition: vi.fn(async () => 'restored' as const),
		cancelPendingLayoutMutation: vi.fn(),
		cancelForUserIntent: vi.fn(() => 'cancelled' as const),
		setNativeScrollActivity: vi.fn(),
		scrollToTarget: vi.fn<ConversationViewportPort['scrollToTarget']>(async () => 'completed'),
	} satisfies ConversationViewportPort;
	let attachedViewport: ConversationViewportPort | null = null;
	panel.attachPresentation(presentationPort(() => attachedViewport));
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

it('does not replay a user-cancelled seek on a presentation attached before viewport lookup', async () => {
	const f = fixture();
	f.attach();
	const seek = pendingSeek();
	const second = {
		...f.viewport,
		scrollToTarget: vi.fn<ConversationViewportPort['scrollToTarget']>()
			.mockImplementationOnce(seek.start)
			.mockResolvedValue('completed'),
	};
	const jump = vi.spyOn(f.panel.scroll, 'jumpToMessageRow');
	const restore = f.panel.restore(readingTarget);
	expect(jump).toHaveBeenCalledOnce();
	f.panel.attachPresentation(presentationPort(() => second));
	await seek.started;
	f.panel.scroll.noteUserScrollIntent('earlier');
	seek.cancel();
	await Promise.all(jump.mock.results.map(call => call.value));
	await restore;
	await tick();
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
	expect(second.scrollToTarget).toHaveBeenCalledOnce();
});

it('resumes an interrupted restore when the same presentation is immediately shown again', async () => {
	const f = fixture();
	f.attach();
	const seek = pendingSeek();
	f.viewport.scrollToTarget.mockImplementationOnce(seek.start);
	const restore = f.panel.restore(readingTarget);
	await seek.started;
	f.panel.prepareForHide();
	f.registry.reconcile([windowPanel]);
	expect(f.registry.panel(windowPanel.surfaceId)).toBe(f.panel);
	seek.cancel();
	await restore;
	await tick();
	expect(f.viewport.scrollToTarget).toHaveBeenCalledTimes(2);
});

it('retains reload identity if the view changes while the target page is held', async () => {
	const f = fixture();
	f.attach();
	const response = held<ChatHistoryResponse>();
	vi.mocked(getChatMessages).mockReturnValue(response.promise);
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
	seedTranscript(f.panel.transcript, chatId, 'view-2', [row(100)], {
		lastOrdinal: 100,
		pageOldestOrdinal: 100,
		nextBeforeOrdinal: 51,
		hasMore: true,
	});
	response.release(page());
	expect(await work).toBe('view-changed');
	expect(f.viewport.scrollToTarget).not.toHaveBeenCalled();
});

function queueSteer(registry: ConversationPanelRegistry): () => void {
	const timestamp = '2026-01-01T00:00:00.000Z';
	const control = emptyChatExecutionControlState('server');
	control.queue.entries = [{ id: 'entry', kind: 'steer', content: 'Synthetic guidance', attachments: [],
		revision: 1, createdAt: timestamp, updatedAt: timestamp }];
	registry.upsertOptimisticInput(chatId, { chatId, clientMessageId: 'own', content: 'Synthetic guidance',
		createdAt: timestamp, delivery: 'pending', placement: 'live-tail' });
	registry.reconcileQueuedSteers(chatId, control, {
		clientMessageId: 'own', entryId: 'entry', serverInstanceId: 'server',
	});
	return () => registry.reconcileQueuedSteers(chatId, emptyChatExecutionControlState('server'));
}

it('preserves held search-result navigation when a queued steer departs', async () => {
	const f = fixture();
	f.attach();
	f.panel.installInitialSnapshot();
	const depart = queueSteer(f.registry);
	const response = held<ChatHistoryResponse>();
	vi.mocked(getChatMessages).mockReturnValueOnce(response.promise).mockResolvedValue(snapshotPage());
	const work = f.panel.navigateToTranscriptRow(target, new AbortController().signal, () => true);
	await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
	depart();
	response.release(page());
	expect(await work).toBe('completed');
	expect(getChatMessages).toHaveBeenCalledOnce();
	expect(f.registry.overlayFor(chatId)?.optimisticInputs).toEqual([]);
	expect(f.viewport.scrollToTarget).toHaveBeenCalledExactlyOnceWith(
		{ kind: 'row', id: 'view-1:100' }, { align: 'center' },
	);
});

it.each(['earlier', 'later'] as const)('leaves held raw %s paging untouched on steer departure', async direction => {
	const f = fixture();
	f.attach();
	seedTranscript(f.panel.transcript, chatId, 'view-1', Array.from({ length: 50 }, (_, i) => row(101 + i)), {
		lastOrdinal: 1000, pageOldestOrdinal: 101, pageNewestOrdinal: 150, nextBeforeOrdinal: 101, hasMore: true,
	});
	const depart = queueSteer(f.registry);
	const response = held<ChatHistoryResponse>();
	vi.mocked(getChatMessages).mockReturnValueOnce(response.promise).mockResolvedValue(snapshotPage());
	const work = direction === 'earlier'
		? f.panel.transcript.loadEarlierPage(chatId) : f.panel.transcript.loadLaterPage(chatId);
	await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
	expect(f.panel.transcript.isPageLoading(direction)).toBe(true);
	depart();
	await vi.waitFor(() => expect(f.registry.overlayFor(chatId)?.optimisticInputs).toEqual([]));
	const start = direction === 'earlier' ? 51 : 151;
	response.release({ ...snapshotPage(), messages: Array.from({ length: 50 }, (_, i) => row(start + i)),
		pageOldestOrdinal: start, pageNewestOrdinal: start + 49, nextBeforeOrdinal: start });
	expect(await work).toBe('loaded');
	expect(getChatMessages).toHaveBeenCalledOnce();
	expect(f.panel.transcript.entries.some(entry => entry.ordinal === start)).toBe(true);
});

it('keeps newer raw live rows when a steer departs during jump-to-latest', async () => {
	const f = fixture();
	f.attach();
	seedTranscript(f.panel.transcript, chatId, 'view-1', [row(100)], {
		lastOrdinal: 1000, pageOldestOrdinal: 100, pageNewestOrdinal: 100, nextBeforeOrdinal: 51, hasMore: true,
	});
	const depart = queueSteer(f.registry);
	const response = held<ChatHistoryResponse>();
	vi.mocked(getChatMessages).mockReturnValueOnce(response.promise);
	const work = f.panel.transcript.navigateToWindow(chatId, 'latest');
	await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
	depart();
	f.registry.applyCommittedBatch({ chatId, transcriptViewId: 'view-1', firstOrdinal: 1001, lastOrdinal: 1001,
		messages: [row(1001)], noticeRevision: 0, resendCandidates: [] });
	response.release(snapshotPage());
	expect(await work).toBe('loaded');
	expect(f.panel.transcript.entries.at(-1)?.ordinal).toBe(1001);
	expect(f.registry.transcriptCache.readAppliedCursor(chatId)).toMatchObject({ lastOrdinal: 1001, stale: false });
	expect(f.registry.transcriptCache.get(chatId)?.messages.at(-1)?.ordinal).toBe(1001);
	expect(getChatMessages).toHaveBeenCalledOnce();
});

it.each(['initial', 'latest'] as const)('honors %s navigation started after a steer departs', async destination => {
	const f = fixture();
	f.attach();
	seedTranscript(f.panel.transcript, chatId, 'view-1', [row(100)], {
		lastOrdinal: 1000, pageOldestOrdinal: 100, pageNewestOrdinal: 100, nextBeforeOrdinal: 51, hasMore: true,
	});
	f.viewport.measureViewportFill.mockResolvedValue('overflow');
	f.viewport.readViewportFill.mockReturnValue('overflow');
	const response = held<ChatHistoryResponse>();
	vi.mocked(getChatMessages).mockReturnValueOnce(response.promise);
	queueSteer(f.registry)();
	const work = destination === 'initial' ? f.panel.scroll.scrollToTop() : f.panel.scroll.scrollToLatest();
	try {
		await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
		response.release(destination === 'latest' ? snapshotPage() : {
			...snapshotPage(), messages: Array.from({ length: 50 }, (_, index) => row(index + 1)), pageOldestOrdinal: 1, pageNewestOrdinal: 50,
			nextBeforeOrdinal: null, hasMore: false,
		});
		await work;
		expect(destination === 'initial' ? f.viewport.scrollToStart : f.viewport.scrollToEnd).toHaveBeenCalledOnce();
		expect(getChatMessages).toHaveBeenCalledOnce();
		expect(f.registry.overlayFor(chatId)?.optimisticInputs).toEqual([]);
	} finally {
		response.release(snapshotPage());
		await work;
	}
});

it.each(['earlier', 'later'] as const)('honors raw %s paging started after a steer departs', async direction => {
	const f = fixture();
	f.attach();
	seedTranscript(f.panel.transcript, chatId, 'view-1', Array.from({ length: 50 }, (_, index) => row(101 + index)), {
		lastOrdinal: 1000, pageOldestOrdinal: 101, pageNewestOrdinal: 150, nextBeforeOrdinal: 101, hasMore: true,
	});
	const response = held<ChatHistoryResponse>();
	vi.mocked(getChatMessages).mockReturnValueOnce(response.promise);
	queueSteer(f.registry)();
	const work = f.panel.scroll.requestPage(direction, 'button');
	try {
		await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
		const start = direction === 'earlier' ? 51 : 151;
		response.release({ ...snapshotPage(), messages: Array.from({ length: 50 }, (_, index) => row(start + index)),
			pageOldestOrdinal: start, pageNewestOrdinal: start + 49, nextBeforeOrdinal: start });
		expect(await work).toBe('loaded');
		expect(f.panel.transcript.entries.some(entry => entry.ordinal === start)).toBe(true);
		expect(getChatMessages).toHaveBeenCalledOnce();
		expect(f.registry.overlayFor(chatId)?.optimisticInputs).toEqual([]);
	} finally {
		response.release(snapshotPage());
		await work;
	}
});

it('keeps newer raw live rows when an ordinary snapshot fails during peer navigation and steer departure', async () => {
	const f = fixture();
	f.attach();
	f.panel.installInitialSnapshot();
	f.registry.reconcile(['one', 'two'].map(name => ({
		surfaceId: `chat-view:window-${name}`, windowId: `window-${name}`, presentation: `window-${name}`,
		chatId, snapshotAdmission: 'admitted',
	} as const)));
	const peer = f.registry.panel('chat-view:window-two')!.transcript;
	seedTranscript(peer, chatId, 'view-1', [row(100)], {
		lastOrdinal: 1000, pageOldestOrdinal: 100, pageNewestOrdinal: 100, nextBeforeOrdinal: 51, hasMore: true,
	});
	const refresh = Promise.withResolvers<ChatHistoryResponse>();
	const response = held<ChatHistoryResponse>();
	const retry = held<ChatHistoryResponse>();
	const retryStarted = held<void>();
	vi.mocked(getChatMessages).mockReturnValueOnce(refresh.promise).mockReturnValueOnce(response.promise)
		.mockImplementationOnce(() => { retryStarted.release(); return retry.promise; });
	const load = f.registry.loadChatSnapshot(chatId).catch(() => false);
	queueSteer(f.registry)();
	await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledOnce());
	const work = peer.navigateToWindow(chatId, 'latest');
	try {
		await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledTimes(2));
		refresh.reject(new Error('Synthetic refresh failure'));
		await Promise.race([load, retryStarted.promise]);
		f.registry.applyCommittedBatch({ chatId, transcriptViewId: 'view-1', firstOrdinal: 1001, lastOrdinal: 1001,
			messages: [row(1001)], noticeRevision: 0, resendCandidates: [] });
		response.release(snapshotPage());
		expect(await work).toBe('loaded');
		expect(peer.entries.at(-1)?.ordinal).toBe(1001);
		expect(f.registry.transcriptCache.readAppliedCursor(chatId)).toMatchObject({ lastOrdinal: 1001, stale: false });
		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(f.registry.overlayFor(chatId)?.optimisticInputs).toEqual([]);
	} finally {
		refresh.reject(new Error('Synthetic refresh failure'));
		response.release(snapshotPage());
		retry.release(snapshotPage());
		await load;
		await work;
	}
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
