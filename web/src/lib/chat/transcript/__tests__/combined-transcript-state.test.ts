import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '$shared/chat-types';
import type { CompleteChatHistoryResponse, TranscriptMessage } from '$shared/chat-view';
import {
	isTranscriptAnchor,
	parseTranscriptAnchorResponse,
	transcriptAnchorWindow,
	type TranscriptAnchorPage,
	type TranscriptAnchorRequest,
} from '$shared/transcript-anchor-page';
import { getChatMessages, getCombinedChatMessages } from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '../conversation-transcript-overlay-store.svelte.js';
import { ConversationScrollController } from '../conversation-scroll-controller.svelte.js';
import type { ConversationViewportPort } from '../conversation-viewport-port.js';
import {
	ConversationPanelRegistry,
	type ConversationPanelDescriptor,
} from '../../conversation/conversation-panel-registry.svelte.js';
import { ConversationLifecycleState } from '../../conversation/conversation-lifecycle-state.svelte.js';
import { CurrentConversationPanelTranscript } from '../../conversation/current-conversation-panel-transcript.js';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(),
	getCombinedChatMessages: vi.fn(),
}));
const time = '2026-01-01T00:00:00.000Z';
const chatId = 'synthetic-chat';
const viewId = 'synthetic-view';
const caches = new Set<ChatTranscriptCache>();
const cleanups: (() => void)[] = [];
const assistant = (ordinal: number): TranscriptMessage => ({
	ordinal,
	message: new AssistantMessage(time, `Synthetic response ${ordinal}`),
});
const tool = (ordinal: number): TranscriptMessage => ({
	ordinal,
	message: new BashToolUseMessage(time, `synthetic-tool-${ordinal}`, 'true'),
});
const input = (ordinal: number): TranscriptMessage => ({
	ordinal,
	message: new UserMessage(time, `Synthetic input ${ordinal}`),
});
function wideAnchorInterval(): TranscriptMessage[] {
	return [input(1), ...Array.from({ length: 650 }, (_, i) => tool(i + 2)), assistant(652)];
}

function fixture(combined = true) {
	const cache = new ChatTranscriptCache({ limit: 100 });
	caches.add(cache);
	const transcript = new ActiveTranscriptState(cache, null, {
		combineMessages: combined,
	});
	cleanups.push(() => transcript.clearMessages());
	transcript.activateChat(chatId);
	return {
		transcript,
		cache,
	};
}
// Explicit cutoffs exercise the generic partial-response contract, not the server producer.
function history(entries: TranscriptMessage[], cutoffRows = Infinity, head = entries.at(-1)?.ordinal ?? 0, view = viewId) {
	const byOrdinal = new Map(entries.map(entry => [entry.ordinal, entry]));
	return (request: TranscriptAnchorRequest): TranscriptAnchorPage => {
		const watermark = request.watermarkOrdinal ?? head;
		const backward = request.direction === 'backward';
		const cursor = request.cursorOrdinal ?? (backward ? watermark + 1 : 0);
		if (watermark > head || cursor > head + (backward ? 1 : 0)) {
			throw new ApiError(409, 'Synthetic cursor ahead', 'TRANSCRIPT_CURSOR_AHEAD');
		}
		let remaining = request.anchorsRemaining;
		let position = backward ? cursor - 1 : cursor + 1;
		let consumed = 0;
		const messages: TranscriptMessage[] = [];
		while (position >= 1 && position <= watermark) {
			const entry = byOrdinal.get(position);
			const anchor = entry !== undefined && isTranscriptAnchor(entry.message);
			if ((anchor && remaining === 0) || consumed === cutoffRows) break;
			if (entry) messages.push(entry);
			if (anchor) remaining -= 1;
			consumed += 1;
			position += backward ? -1 : 1;
		}
		const atEdge = backward ? position === 0 : position === watermark + 1;
		const boundary = byOrdinal.get(position);
		let pageStatus: TranscriptAnchorPage['pageStatus'] = 'partial';
		if (atEdge) pageStatus = 'exhausted';
		else if (remaining === 0 && boundary && isTranscriptAnchor(boundary.message)) pageStatus = 'complete';
		const page: TranscriptAnchorPage = {
			chatId,
			transcriptViewId: view,
			historyState: { kind: 'complete' },
			direction: request.direction,
			lastOrdinal: head,
			watermarkOrdinal: watermark,
			anchorsRemaining: remaining,
			startOrdinal: backward ? cursor - consumed : cursor + 1,
			endOrdinal: backward ? cursor : cursor + consumed + 1,
			messages: backward ? messages.reverse() : messages,
			resendCandidates: [],
			pageStatus,
		};
		return parseTranscriptAnchorResponse(request, page) as TranscriptAnchorPage;
	};
}
const installHistory = (entries: TranscriptMessage[], cutoffRows = Infinity, head?: number) => {
	const read = history(entries, cutoffRows, head);
	vi.mocked(getCombinedChatMessages).mockImplementation(async (request) => read(request));
	return read;
};

function testViewport() {
	return {
		isReady: vi.fn(() => true),
		isAtEnd: vi.fn(() => true),
		ownsScrollPosition: () => false,
		viewportPosition: () => ({
			logicalOffset: 500,
			distanceFromStart: 500,
			leadingContentReachable: true,
		}),
		scrollToStart: vi.fn(),
		scrollToEnd: vi.fn(),
		restoreInitialEnd: vi.fn(),
		scrollBy: vi.fn(),
		waitForLayout: vi.fn<ConversationViewportPort['waitForLayout']>(async () => 'settled'),
		measureViewportFill: vi.fn<ConversationViewportPort['measureViewportFill']>(
			async () => 'overflow',
		),
		readViewportFill: vi.fn<ConversationViewportPort['readViewportFill']>(() => 'overflow'),
		onNextMeasurement: vi.fn<ConversationViewportPort['onNextMeasurement']>(() => () => {}),
		restoreHiddenReadingPosition: async () => 'restored' as const,
		cancelPendingLayoutMutation: vi.fn(),
		cancelForUserIntent: () => 'cancelled' as const,
		setNativeScrollActivity: vi.fn(),
		scrollToTarget: async () => 'completed' as const,
	} satisfies ConversationViewportPort;
}

function scrolling(transcript: ActiveTranscriptState, scrollContainer: HTMLDivElement | null = null) {
	const viewport = testViewport();
	const controller = new ConversationScrollController({
		chatState: transcript,
		getChatId: () => chatId,
		getViewport: () => viewport,
		getScrollContainer: () => scrollContainer,
		getQueueContainer: () => undefined,
	});
	cleanups.push(() => controller.destroy());
	return { controller, viewport };
}

function panelFixture(options: { maxHiddenEntries?: number; retainInactive?: boolean } = {}) {
	const cache = new ChatTranscriptCache({ limit: 100, maxHiddenEntries: options.maxHiddenEntries });
	caches.add(cache);
	const overlays = new ConversationTranscriptOverlayStore();
	const lifecycle = new ConversationLifecycleState();
	lifecycle.setCurrentChatId(chatId);
	const registry = new ConversationPanelRegistry({
		cache,
		overlays,
		lifecycle: { forChat: () => lifecycle, remove: () => {} },
		getSelectedChatId: () => chatId,
		getComposerAnchorSurfaceId: () => 'chat-view:window-left',
		combineMessages: true,
		retainInactiveWindows: () => options.retainInactive ?? false,
	});
	cleanups.push(() => registry.destroy());
	const descriptor = (name: string, id = chatId): ConversationPanelDescriptor => ({
		chatId: id,
		surfaceId: `chat-view:window-${name}`,
		presentation: `window-${name}`,
		windowId: `window-${name}`,
		snapshotAdmission: 'admitted',
	});
	return {
		cache,
		overlays,
		registry,
		mount: (...names: string[]) => registry.reconcile(names.map(name => descriptor(name))),
		switchChat: (id: string) => {
			const visible = [descriptor('left', id)];
			registry.prepareForReconcile(visible);
			registry.reconcile(visible);
		},
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	localStorage.clear();
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	for (const cache of caches) cache.flush();
	caches.clear();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('combined transcript intervals', () => {
	it.each([
		['snapshot', null],
		['earlier', 652],
		['later', 1],
		['initial', 300],
		['latest', 300],
	] as const)('installs a whole wide interval through %s', async (target, residentOrdinal) => {
		const { transcript, cache } = fixture();
		const entries = wideAnchorInterval();
		installHistory(entries);
		if (residentOrdinal !== null) {
			transcript.replaceGeneration(chatId, viewId, [entries[residentOrdinal - 1]], {
				lastOrdinal: 652, pageNewestOrdinal: residentOrdinal, pageOldestOrdinal: residentOrdinal,
				nextBeforeOrdinal: residentOrdinal === 1 ? null : residentOrdinal, hasMore: residentOrdinal > 1,
			});
		}
		if (target === 'snapshot') await transcript.loadMessages(chatId);
		else if (target === 'earlier') await transcript.loadEarlierPage(chatId);
		else if (target === 'later') await transcript.loadLaterPage(chatId);
		else await transcript.navigateToWindow(chatId, target);
		expect(transcript.entries).toEqual(entries);
		expect(transcript.hasPendingAnchorDemand('earlier')).toBe(false);
		expect(transcript.hasPendingAnchorDemand('later')).toBe(false);
		expect(getCombinedChatMessages).toHaveBeenCalledOnce();
		expect(cache.get(chatId)!.messages.length).toBeLessThanOrEqual(100);
	});

	it('preserves a buffered live suffix while installing a wide fixed-watermark snapshot', async () => {
		const { transcript } = fixture();
		const entries = wideAnchorInterval();
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const load = transcript.loadMessages(chatId);
		transcript.applyMessages(chatId, viewId, [input(653)], 653, 653);
		response.resolve(history(entries)(vi.mocked(getCombinedChatMessages).mock.calls[0][0]));
		await load;
		expect(transcript.entries).toEqual([...entries, input(653)]);
		expect(transcript.lastOrdinal).toBe(653);
	});

	it('does not publish a wide earlier response rejected by the application gate', async () => {
		const { transcript } = fixture();
		const entries = wideAnchorInterval();
		transcript.replaceGeneration(chatId, viewId, [assistant(652)], {
			lastOrdinal: 652, pageOldestOrdinal: 652, nextBeforeOrdinal: 652, hasMore: true,
		});
		installHistory(entries);
		const gate = vi.fn().mockResolvedValue('invalidated');
		expect(await transcript.loadEarlierPage(chatId, { applicationGate: gate })).toBe('invalidated');
		expect(transcript.entries).toEqual([assistant(652)]);
		expect(transcript.nextBeforeOrdinal).toBe(652);
		await transcript.loadEarlierPage(chatId);
		expect(transcript.entries).toEqual(entries);
	});

	it('discards a wide snapshot after chat ownership changes', async () => {
		const { transcript } = fixture();
		const entries = wideAnchorInterval();
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const load = transcript.loadMessages(chatId);
		transcript.activateChat('other-chat');
		response.resolve(history(entries)(vi.mocked(getCombinedChatMessages).mock.calls[0][0]));
		await load;
		expect(transcript.entries).toEqual([]);
	});

	it.each(['none', 'unpin', 'replacement', 'intent'] as const)('restores a deferred pinned end only while still owned (%s)', async interruption => {
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(1);
		const { transcript } = fixture();
		installHistory(Array.from({ length: 201 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const { controller, viewport } = scrolling(transcript);
		const layout = Promise.withResolvers<'settled'>();
		viewport.waitForLayout.mockResolvedValueOnce('settled').mockImplementationOnce(() => layout.promise);
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.advanceTimersByTimeAsync(1);
			expect(transcript.entries).toHaveLength(201);
			controller.noteUserScrollIntent(null, 'other');
			layout.resolve('settled');
			await fill;
			expect(viewport.scrollToEnd).not.toHaveBeenCalled();
			viewport.isAtEnd.mockReturnValue(false);
			if (interruption === 'unpin') controller.setPinnedToBottom(false);
			if (interruption === 'replacement') transcript.replaceGeneration(chatId, viewId, [assistant(1)], {
				lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false,
			});
			if (interruption === 'intent') {
				controller.noteUserScrollIntent('earlier', 'other');
				await vi.advanceTimersByTimeAsync(2001);
			}
			controller.finishDirectionlessUserScrollIntent();
			await controller.fillUnderfilledViewport();
			expect(viewport.scrollToEnd).toHaveBeenCalledTimes(interruption === 'none' ? 1 : 0);
			await controller.fillUnderfilledViewport();
			expect(viewport.scrollToEnd).toHaveBeenCalledTimes(interruption === 'none' ? 1 : 0);
		} finally {
			layout.resolve('settled');
			controller.destroy();
		}
	});

	it('does not restore navigator pinning after newer user intent', async () => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 401 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const { controller, viewport } = scrolling(transcript);
		try {
			const navigation = controller.loadEarlierPageForNavigator(chatId);
			controller.noteUserScrollIntent('earlier', 'other');
			response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			expect(await navigation).toBe('invalidated');
			expect(transcript.entries).toHaveLength(401);
			expect(viewport.scrollToEnd).not.toHaveBeenCalled();
		} finally {
			controller.destroy();
		}
	});

	it('defers the pinned end after coverage layout is superseded by intent', async () => {
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(1);
		const { transcript } = fixture();
		installHistory(Array.from({ length: 201 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const { controller, viewport } = scrolling(transcript);
		const layout = Promise.withResolvers<'superseded'>();
		viewport.waitForLayout.mockResolvedValueOnce('settled').mockImplementationOnce(() => layout.promise);
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.advanceTimersByTimeAsync(1);
			expect(transcript.entries).toHaveLength(201);
			expect(viewport.waitForLayout.mock.results.at(-1)?.value).toBe(layout.promise);
			controller.noteUserScrollIntent('earlier', 'other');
			layout.resolve('superseded');
			await fill;
			expect(viewport.scrollToEnd).not.toHaveBeenCalled();
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(2);
			viewport.isAtEnd.mockReturnValue(false);
			await vi.advanceTimersByTimeAsync(2001);
			await controller.fillUnderfilledViewport();
			expect(transcript.entries).toHaveLength(201);
			expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
		} finally {
			controller.destroy();
		}
	});

	it('finishes the Start control before obsolete coverage transport settles', async () => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 601 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const { controller, viewport } = scrolling(transcript);
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			const start = controller.scrollToTop();
			await vi.waitFor(() => expect(viewport.scrollToStart).toHaveBeenCalledOnce());
			expect(controller.isScrollingToTop).toBe(false);
			await start;
			response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			await fill;
		} finally {
			controller.destroy();
		}
	});

	it('accepts newer fallback handoff after loader and captured peer snapshot replacements', async () => {
		const { registry, cache, mount } = panelFixture();
		cache.replace(chatId, viewId, [assistant(1)], 1, null);
		const current = new CurrentConversationPanelTranscript({ panels: registry, getSelectedChatId: () => chatId });
		current.activateChat(chatId);
		const response = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockImplementationOnce(() => response.promise);
		const fallback = current.loadMessages(chatId);
		try {
			mount('left', 'right');
			const replacementView = 'synthetic-replacement';
			vi.mocked(getCombinedChatMessages).mockImplementation(async request => history([assistant(1), assistant(2)], 200, 2, replacementView)(request));
			await registry.loadChatSnapshot(chatId);
			for (const panel of registry.panelsForChat(chatId)) expect(panel.transcript.lastOrdinal).toBe(2);
			response.resolve({ chatId, transcriptViewId: replacementView, messages: [assistant(1), assistant(2), assistant(3)],
				lastOrdinal: 3, pageOldestOrdinal: 1, pageNewestOrdinal: 3, nextBeforeOrdinal: null, hasMore: false,
				historyState: { kind: 'complete' }, limit: 50, resendCandidates: [] });
			await fallback;
			expect(cache.get(chatId)?.lastOrdinal).toBe(3);
			for (const panel of registry.panelsForChat(chatId)) expect(panel.transcript.lastOrdinal).toBe(3);
		} finally {
			registry.destroy();
			cache.flush();
		}
	});

	it.each(['transport', 'layout'] as const)('releases superseded coverage ownership before cancelling Latest during %s', async phase => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 601 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const coverageResponse = Promise.withResolvers<TranscriptAnchorPage>();
		const navigationResponse = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => coverageResponse.promise).mockImplementationOnce(() => navigationResponse.promise);
		const { controller, viewport } = scrolling(transcript);
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			transcript.lastOrdinal = 602;
			transcript.hasLaterMessages = true;
			const layout = Promise.withResolvers<'settled'>();
			const navigation = controller.scrollToLatest();
			if (phase === 'layout') {
				viewport.waitForLayout.mockImplementationOnce(() => layout.promise);
				navigationResponse.resolve(history(Array.from({ length: 602 }, (_, index) => tool(index + 1)), 200)(vi.mocked(getCombinedChatMessages).mock.calls[2]![0]));
				await vi.waitFor(() => expect(viewport.waitForLayout.mock.results.at(-1)?.value).toBe(layout.promise));
			}
			controller.noteUserScrollIntent('earlier', 'other');
			const page = vi.spyOn(transcript, 'loadEarlierPage').mockResolvedValue('exhausted');
			expect(await controller.requestPage('earlier', 'button')).toBe('exhausted');
			expect(page).toHaveBeenCalledOnce();
			if (phase === 'layout') layout.resolve('settled');
			else navigationResponse.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[2]![0]));
			coverageResponse.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			await navigation;
			await fill;
			expect(viewport.scrollToEnd).not.toHaveBeenCalled();
		} finally {
			controller.destroy();
		}
	});

	it('finishes the Latest control before its combined coverage transport settles', async () => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 401 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const { controller } = scrolling(transcript);
		try {
			const jump = controller.scrollToLatestAndFill();
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			expect(controller.isScrollingToBottom).toBe(false);
			await jump;
			response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			await controller.fillUnderfilledViewport();
		} finally {
			controller.destroy();
		}
	});

	it.each([true, false])('gives navigator paging ownership over later coverage (coverage first %s)', async coverageFirst => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 600 }, (_, index) => tool(index + 1)), 200);
		transcript.replaceGeneration(chatId, viewId, [tool(300)], {
			lastOrdinal: 600, pageOldestOrdinal: 300, pageNewestOrdinal: 300, nextBeforeOrdinal: 300, hasMore: true,
		});
		const later = Promise.withResolvers<TranscriptAnchorPage>();
		const earlier = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementation(request => request.direction === 'forward' ? later.promise : earlier.promise);
		const { controller, viewport } = scrolling(transcript);
		viewport.readViewportFill.mockReturnValue('underfilled');
		controller.setPinnedToBottom(false);
		try {
			const fill = coverageFirst ? controller.fillUnderfilledViewport() : null;
			if (fill) await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(1));
			const navigation = controller.loadEarlierPageForNavigator(chatId);
			await vi.waitFor(() => expect(vi.mocked(getCombinedChatMessages).mock.calls.some(([request]) => request.direction === 'backward')).toBe(true));
			if (!coverageFirst) await controller.fillUnderfilledViewport();
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(coverageFirst ? 2 : 1);
			const earlierRequest = vi.mocked(getCombinedChatMessages).mock.calls.find(([request]) => request.direction === 'backward')![0];
			vi.mocked(getCombinedChatMessages).mockImplementation(async request => read(request));
			earlier.resolve(read(earlierRequest));
			expect(await navigation).toBe('loaded');
			if (fill) {
				later.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
				await fill;
			}
			await vi.waitFor(() => expect(transcript.loadedThroughOrdinal).toBe(600));
		} finally {
			controller.destroy();
		}
	});

	it.each(['row', 'initial'] as const)('preserves recovery started while %s navigation drains superseded Latest', async (target) => {
		const { transcript } = detached();
		const latestResponse = Promise.withResolvers<TranscriptAnchorPage>();
		const recovery = Promise.withResolvers<TranscriptAnchorPage>();
		const replacement = history([input(1)], 200, 1, 'replacement-view');
		vi.mocked(getCombinedChatMessages)
			.mockImplementationOnce(() => latestResponse.promise)
			.mockImplementationOnce(() => recovery.promise)
			.mockImplementation(async request => replacement(request));
		const latest = transcript.navigateToWindow(chatId, 'latest');
		expect(transcript.applyMessages(chatId, 'replacement-view', [input(1)], 1, 1)).toBe('applied');
		const superseding = target === 'row'
			? transcript.navigateToRow({ chatId, transcriptViewId: viewId, ordinal: 50 }, new AbortController().signal, () => true)
			: transcript.navigateToWindow(chatId, target);
		expect(await superseding).toBe(target === 'row' ? 'unavailable' : 'invalidated');
		expect(transcript.isLoadingMessages).toBe(true);
		expect(getChatMessages).not.toHaveBeenCalled();
		recovery.resolve(replacement(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
		await vi.waitFor(() => expect(transcript.isLoadingMessages).toBe(false));
		latestResponse.resolve(history([assistant(1000)], 200, 1001)(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
		expect(await latest).toBe('invalidated');
		expect(transcript.transcriptViewId).toBe('replacement-view');
		expect(transcript.applyMessages(chatId, 'replacement-view', [assistant(2)], 2, 2)).toBe('applied');
		expect(transcript.lastOrdinal).toBe(2);
		expect(await transcript.navigateToWindow(chatId, 'initial')).toBe('loaded');
	});

	it('recovers a Latest install whose buffered commits belong to a replacement view', async () => {
		const { transcript } = detached();
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages)
			.mockImplementationOnce(() => response.promise)
			.mockImplementation(async request => history([input(1)], 200, 1, 'replacement-view')(request));
		const latest = transcript.navigateToWindow(chatId, 'latest');
		transcript.applyMessages(chatId, 'replacement-view', [input(1)], 1, 1);
		response.resolve(history([assistant(1000)], 200, 1001)(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
		expect(await latest).toBe('invalidated');
		await vi.waitFor(() => expect(transcript.transcriptViewId).toBe('replacement-view'));
		expect(transcript.isLoadingMessages).toBe(false);
		expect(transcript.applyMessages(chatId, 'replacement-view', [assistant(2)], 2, 2)).toBe('applied');
		expect(transcript.lastOrdinal).toBe(2);
	});

	it('preserves transport errors when detached coverage becomes overflowing, until explicit retry', async () => {
		const { transcript } = fixture();
		installHistory(Array.from({ length: 401 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { controller, viewport } = scrolling(transcript);
		controller.setPinnedToBottom(false);
		viewport.readViewportFill.mockReturnValue('underfilled');
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			viewport.readViewportFill.mockReturnValue('overflow');
			response.reject(new Error('Synthetic transport failure'));
			await fill;
			expect(transcript.pageStates.earlier).toEqual({ status: 'error', error: 'Synthetic transport failure' });
			controller.setViewportVisible(false);
			controller.setViewportVisible(true);
			viewport.readViewportFill.mockReturnValue('underfilled');
			controller.wakeCoverage();
			await controller.fillUnderfilledViewport();
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(2);
			expect(transcript.nextBeforeOrdinal).toBe(202);
			expect(await controller.requestPage('earlier', 'button')).toBe('loaded');
			expect(transcript.entries).toHaveLength(401);
		} finally {
			controller.destroy();
		}
	});

	it('forces same-view rollback recovery even after detached coverage becomes overflowing', async () => {
		const { transcript, cache } = fixture();
		transcript.replaceGeneration(chatId, viewId, Array.from({ length: 100 }, (_, i) => assistant(i + 2)), {
			lastOrdinal: 101, pageOldestOrdinal: 2, nextBeforeOrdinal: 2, hasMore: true,
		});
		installHistory(Array.from({ length: 80 }, (_, i) => assistant(i + 1)));
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const { controller, viewport } = scrolling(transcript);
		controller.setPinnedToBottom(false);
		viewport.readViewportFill.mockReturnValue('underfilled');
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledOnce());
			viewport.readViewportFill.mockReturnValue('overflow');
			response.reject(new ApiError(409, 'Synthetic rollback', 'TRANSCRIPT_CURSOR_AHEAD'));
			await fill;
			expect(transcript.lastOrdinal).toBe(80);
			expect(transcript.entries.at(-1)?.ordinal).toBe(80);
			expect(cache.readAppliedCursor(chatId)?.lastOrdinal).toBe(80);
			expect(transcript.hasPendingAnchorDemand('earlier')).toBe(false);
		} finally {
			controller.destroy();
		}
	});

	it.each([false, true])('pauses continuation for recent keyboard/wheel intent unless manually joined (%s)', async manual => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 601 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const { controller } = scrolling(transcript);
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			const join = manual ? controller.requestPage('earlier', 'button') : null;
			controller.noteUserScrollIntent('earlier', 'other');
			response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			await fill;
			await join;
			if (!manual) {
				expect(transcript.entries).toHaveLength(200);
				expect(getCombinedChatMessages).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(1900);
				expect(getCombinedChatMessages).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(101);
				await controller.fillUnderfilledViewport();
			}
			expect(transcript.entries).toHaveLength(601);
		} finally {
			controller.destroy();
		}
	});

	it.each([false, true])('keeps pinning through non-owned scroll events during fill (combined %s)', async combined => {
		const { transcript } = fixture(combined);
		const entries = Array.from({ length: 401 }, (_, index) => tool(index + 1));
		const read = installHistory(entries, 200);
		if (combined) await transcript.loadMessages(chatId);
		else transcript.replaceGeneration(chatId, viewId, [assistant(100)], {
			lastOrdinal: 100, pageOldestOrdinal: 100, nextBeforeOrdinal: 100, hasMore: true,
		});
		const anchor = Promise.withResolvers<TranscriptAnchorPage>();
		const raw = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => anchor.promise);
		vi.mocked(getChatMessages).mockImplementationOnce(() => raw.promise);
		const scroller = document.createElement('div');
		Object.defineProperty(scroller, 'clientHeight', { value: 400 });
		const { controller, viewport } = scrolling(transcript, scroller);
		viewport.measureViewportFill.mockResolvedValue('underfilled');
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.waitFor(() => expect(combined ? getCombinedChatMessages : getChatMessages).toHaveBeenCalledTimes(combined ? 2 : 1));
			controller.handleScroll();
			expect(controller.isPinnedToBottom).toBe(true);
			if (combined) anchor.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			else {
				viewport.measureViewportFill.mockResolvedValue('overflow');
				raw.resolve({ chatId, ...transcriptAnchorWindow(history(Array.from({ length: 50 }, (_, index) => assistant(index + 50)), 50, 99)({ chatId, direction: 'backward', anchorsRemaining: 100 })), historyState: { kind: 'complete' }, limit: 50, resendCandidates: [] });
			}
			await fill;
			expect(controller.isPinnedToBottom).toBe(true);
			expect(viewport.scrollToEnd).toHaveBeenCalled();
		} finally {
			controller.destroy();
		}
	});

	it('resumes pinned activation after hide/show while obsolete transport is held', async () => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 601 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const { controller } = scrolling(transcript);
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			controller.setViewportVisible(false);
			controller.setViewportVisible(true);
			const resumed = controller.fillUnderfilledViewport();
			response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			await fill;
			await resumed;
			await vi.waitFor(() => expect(transcript.entries).toHaveLength(601));
			expect(transcript.hasEarlierMessages).toBe(false);
		} finally {
			controller.destroy();
		}
	});

	it.each([false, true])('waits for show-time readiness before resuming coverage (pinned %s)', async pinned => {
		const { transcript } = fixture();
		installHistory(Array.from({ length: 401 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const { controller, viewport } = scrolling(transcript);
		controller.setPinnedToBottom(false);
		await controller.fillUnderfilledViewport();
		controller.setViewportVisible(false);
		controller.setPinnedToBottom(pinned);
		viewport.isReady.mockReturnValue(false);
		viewport.readViewportFill.mockReturnValue('underfilled');
		let measurementWake: (() => void) | undefined;
		viewport.onNextMeasurement.mockImplementation(wake => {
			measurementWake = wake;
			return () => { measurementWake = undefined; };
		});
		try {
			controller.setViewportVisible(true);
			await vi.waitFor(() => expect(measurementWake).toBeDefined());
			expect(getCombinedChatMessages).toHaveBeenCalledOnce();
			viewport.isReady.mockReturnValue(true);
			measurementWake!();
			await vi.waitFor(() => expect(transcript.entries).toHaveLength(401));
			expect(controller.isPinnedToBottom).toBe(pinned);
		} finally {
			controller.destroy();
		}
	});

	it('retries superseded detached measurements before fetching a continuation', async () => {
		const { transcript } = fixture();
		installHistory(Array.from({ length: 401 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const { controller, viewport } = scrolling(transcript);
		controller.setPinnedToBottom(false);
		viewport.readViewportFill.mockImplementation(() => transcript.entries.length < 401 ? 'underfilled' : 'overflow');
		let layouts = 0;
		viewport.waitForLayout.mockImplementation(async () => {
			layouts += 1;
			if (layouts === 2 || layouts === 3) {
				expect(getCombinedChatMessages).toHaveBeenCalledOnce();
				return 'superseded';
			}
			return 'settled';
		});
		try {
			await controller.fillUnderfilledViewport();
			expect(transcript.entries).toHaveLength(401);
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(3);
			expect(viewport.scrollToEnd).not.toHaveBeenCalled();
		} finally {
			controller.destroy();
		}
	});

	it('rechecks recent intent after a held passive measurement before applying a chunk', async () => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 401 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const { controller, viewport } = scrolling(transcript);
		controller.setPinnedToBottom(false);
		viewport.readViewportFill.mockReturnValue('underfilled');
		const layout = Promise.withResolvers<'settled'>();
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			viewport.waitForLayout.mockResolvedValueOnce('settled').mockImplementationOnce(() => layout.promise);
			response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			await vi.waitFor(() => expect(viewport.waitForLayout.mock.results.at(-1)?.value).toBe(layout.promise));
			controller.noteUserScrollIntent('earlier', 'other');
			layout.resolve('settled');
			await fill;
			expect(transcript.entries).toHaveLength(200);
			expect(transcript.nextBeforeOrdinal).toBe(202);
		} finally {
			controller.destroy();
		}
	});

	it('retries a hidden-only new-view snapshot when cursor recovery cannot replace the old cache view', async () => {
		const { cache, registry, mount } = panelFixture();
		cache.replace(chatId, viewId, [assistant(1)], 1, null);
		mount('left');
		const transcript = registry.panelsForChat(chatId)[0]!.transcript;
		const nextView = 'synthetic-new-view';
		vi.mocked(getCombinedChatMessages)
			.mockImplementationOnce(async request => history([input(1)], 200, 401, nextView)(request))
			.mockRejectedValueOnce(new ApiError(409, 'Synthetic rollback', 'TRANSCRIPT_CURSOR_AHEAD'))
			.mockImplementation(async request => history([input(1)], 200, 1, nextView)(request));
		try {
			await registry.loadChatSnapshot(chatId);
			expect(transcript.isLoadingMessages).toBe(false);
			expect(transcript.transcriptViewId).toBe(nextView);
			expect(transcript.lastOrdinal).toBe(1);
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(3);
		} finally {
			registry.destroy();
		}
	});

	it('accepts snapshot handoff after no-op or cancelled navigation, but not during navigation', async () => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 401 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const beforeNavigation = transcript.snapshotHandoffGuard();
		await transcript.navigateToWindow(chatId, 'latest');
		expect(beforeNavigation()).toBe(true);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const navigation = transcript.navigateToWindow(chatId, 'initial');
		const duringNavigation = transcript.snapshotHandoffGuard();
		expect(beforeNavigation()).toBe(false);
		expect(duringNavigation()).toBe(false);
		transcript.invalidatePendingWindowNavigation();
		expect(beforeNavigation()).toBe(true);
		expect(duringNavigation()).toBe(true);
		response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
		expect(await navigation).toBe('invalidated');
	});

	it.each([false, true])('releases cancelled window navigation before held transport settles (combined %s)', async combined => {
		const { transcript } = fixture(combined);
		const entries = Array.from({ length: 401 }, (_, index) => tool(index + 1));
		const read = installHistory(entries, 200);
		transcript.replaceGeneration(chatId, viewId, [assistant(300)], {
			lastOrdinal: 401, pageNewestOrdinal: 300, pageOldestOrdinal: 300, nextBeforeOrdinal: 300, hasMore: true,
		});
		const anchor = Promise.withResolvers<TranscriptAnchorPage>();
		const raw = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => anchor.promise);
		vi.mocked(getChatMessages).mockImplementationOnce(() => raw.promise);
		const { controller } = scrolling(transcript);
		const page = vi.spyOn(transcript, 'loadEarlierPage').mockResolvedValue('exhausted');
		try {
			const navigation = controller.scrollToLatest();
			controller.noteUserScrollIntent('earlier', 'other');
			expect(await controller.requestPage('earlier', 'button')).toBe('exhausted');
			expect(page).toHaveBeenCalledOnce();
			if (combined) anchor.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
			else raw.resolve({ chatId, ...transcriptAnchorWindow(read({ chatId, direction: 'backward', anchorsRemaining: 100 })), historyState: { kind: 'complete' }, limit: 200, resendCandidates: [] });
			await navigation;
		} finally {
			controller.destroy();
		}
	});

	it.each(['paging', 'latest', 'initial'] as const)('surfaces degraded history from combined %s', async target => {
		const { transcript } = fixture();
		installHistory(Array.from({ length: 401 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		if (target === 'latest') await transcript.navigateToWindow(chatId, 'initial');
		const historyState = { kind: 'degraded', errorCode: 'LEDGER_FENCED', retryable: false } as const;
		vi.mocked(getCombinedChatMessages).mockResolvedValueOnce({ chatId, messages: [], historyState });
		await (target === 'paging' ? transcript.loadEarlierPage(chatId) : transcript.navigateToWindow(chatId, target));
		expect(transcript.historyState).toEqual(historyState);
		expect(transcript.isLoadingMessages).toBe(false);
	});

	it('adopts the newer cache view when a stale peer cannot reset shared authority', async () => {
		const { registry, cache, mount } = panelFixture();
		installHistory(Array.from({ length: 300 }, (_, index) => tool(index + 1)), 200);
		try {
			mount('left');
			await registry.loadChatSnapshot(chatId);
			const transcript = registry.panel('chat-view:window-left')!.transcript;
			cache.replace(chatId, 'replacement-view', [input(1)], 1, null);
			vi.mocked(getCombinedChatMessages).mockRejectedValueOnce(new ApiError(409, 'Synthetic stale view', 'STALE_TRANSCRIPT_VIEW'));
			await transcript.loadEarlierPage(chatId);
			expect(transcript.transcriptViewId).toBe('replacement-view');
			expect(transcript.entries).toEqual([input(1)]);
			expect(cache.readAppliedCursor(chatId)).toMatchObject({ transcriptViewId: 'replacement-view', lastOrdinal: 1, stale: false });
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(2);
		} finally {
			registry.destroy();
			cache.flush();
		}
	});

	it.each([false, true])('keeps the broadest equal-head snapshot through fallback handoff (broad first %s)', async broadFirst => {
		const { registry, cache, mount } = panelFixture();
		const entries = Array.from({ length: 100 }, (_, index) => assistant(index + 1));
		const current = new CurrentConversationPanelTranscript({ panels: registry, getSelectedChatId: () => chatId });
		current.activateChat(chatId);
		const response = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockImplementationOnce(() => response.promise);
		const fallback = current.loadMessages(chatId, { minimumLimit: broadFirst ? 50 : 100 });
		try {
			const first = broadFirst ? entries : entries.slice(50);
			const last = broadFirst ? entries.slice(50) : entries;
			cache.replace(chatId, viewId, first, 100, broadFirst ? null : 51);
			mount('left');
			response.resolve({ chatId, transcriptViewId: viewId, messages: last, lastOrdinal: 100, pageOldestOrdinal: last[0]!.ordinal, pageNewestOrdinal: 100, nextBeforeOrdinal: broadFirst ? 51 : null, hasMore: broadFirst, historyState: { kind: 'complete' }, limit: broadFirst ? 50 : 100, resendCandidates: [] });
			await fallback;
			expect(cache.get(chatId)?.messages).toEqual(entries);
			expect(cache.get(chatId)?.nextBeforeOrdinal).toBeNull();
			expect(registry.panel('chat-view:window-left')!.transcript.entries).toEqual(entries);
		} finally {
			registry.destroy();
			cache.flush();
		}
	});

	it.each(['fallback', 'peer'] as const)('fences a late %s snapshot handoff after a newly mounted panel begins row navigation', async source => {
		const { registry, cache, mount } = panelFixture();
		cache.replace(chatId, viewId, [assistant(1000)], 1001, 1000);
		const current = new CurrentConversationPanelTranscript({ panels: registry, getSelectedChatId: () => chatId });
		current.activateChat(chatId);
		const response = Promise.withResolvers<CompleteChatHistoryResponse>();
		const anchor = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getChatMessages).mockImplementationOnce(() => response.promise);
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => anchor.promise);
		if (source === 'peer') mount('left');
		const snapshot = source === 'fallback' ? current.loadMessages(chatId) : registry.loadChatSnapshot(chatId);
		if (source === 'peer') vi.mocked(getChatMessages).mockReset();
		try {
			mount(...(source === 'peer' ? ['left', 'right'] : ['right']));
			const transcript = registry.panel('chat-view:window-right')!.transcript;
			const row = Promise.withResolvers<CompleteChatHistoryResponse>();
			vi.mocked(getChatMessages).mockImplementationOnce(() => row.promise);
			const navigation = transcript.navigateToRow({ chatId, transcriptViewId: viewId, ordinal: 50 }, new AbortController().signal, () => true);
			if (source === 'fallback') response.resolve({ chatId, transcriptViewId: viewId, historyState: { kind: 'complete' }, messages: Array.from({ length: 50 }, (_, index) => assistant(index + 952)), lastOrdinal: 1001, pageOldestOrdinal: 952, pageNewestOrdinal: 1001, nextBeforeOrdinal: 952, hasMore: true, limit: 50, resendCandidates: [] });
			else anchor.resolve(history([assistant(1000)], 200, 1001)(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
			await snapshot;
			row.resolve({ chatId, transcriptViewId: viewId, historyState: { kind: 'complete' }, messages: [assistant(50)], lastOrdinal: 1001, pageOldestOrdinal: 50, pageNewestOrdinal: 50, nextBeforeOrdinal: null, hasMore: false, limit: 50, resendCandidates: [] });
			expect(await navigation).toBe('loaded');
			expect(transcript.entries).toEqual([assistant(50)]);
		} finally {
			registry.destroy();
			cache.flush();
		}
	});

	it.each(['hide', 'snapshot'] as const)('retains raw error clearing on %s', async action => {
		const { transcript } = fixture(false);
		transcript.replaceGeneration(chatId, viewId, [assistant(100)], { lastOrdinal: 100, pageOldestOrdinal: 100, nextBeforeOrdinal: 100, hasMore: true });
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(getChatMessages).mockRejectedValueOnce(new Error('Synthetic raw failure'));
		expect(await transcript.loadEarlierPage(chatId)).toBe('failed');
		expect(transcript.pageStates.earlier.status).toBe('error');
		if (action === 'hide') transcript.invalidatePendingHistoryLoad();
		else transcript.setFromPage(chatId, { transcriptViewId: viewId, messages: [assistant(100)], lastOrdinal: 100, pageOldestOrdinal: 100, pageNewestOrdinal: 100, nextBeforeOrdinal: 100, hasMore: true }, transcript.beginSnapshotLoad());
		expect(transcript.pageStates.earlier).toEqual({ status: 'idle', error: null });
	});

	it.each(['apply', 'invalidated'] as const)('keeps raw page errors behind an %s application gate', async decision => {
		const { transcript, cache } = fixture(false);
		transcript.replaceGeneration(chatId, viewId, [assistant(100)], {
			lastOrdinal: 100, pageOldestOrdinal: 100, nextBeforeOrdinal: 100, hasMore: true,
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(getChatMessages).mockRejectedValueOnce(new Error('Synthetic raw failure'));
		const gate = Promise.withResolvers<'apply' | 'invalidated'>();
		const applicationGate = vi.fn(() => gate.promise);
		const load = transcript.loadEarlierPage(chatId, { applicationGate });
		try {
			await vi.waitFor(() => expect(applicationGate).toHaveBeenCalledOnce());
			expect(transcript.pageStates.earlier.status).toBe('loading');
			gate.resolve(decision);
			expect(await load).toBe('failed');
			expect(transcript.pageStates.earlier.status).toBe(decision === 'apply' ? 'error' : 'idle');
		} finally {
			gate.resolve(decision);
			await load;
			cache.flush();
		}
	});

	it('waits for layout and restores pinning when a raw navigator joins an earlier load', async () => {
		const { transcript, cache } = fixture(false);
		transcript.replaceGeneration(chatId, viewId, [assistant(100)], {
			lastOrdinal: 100, pageOldestOrdinal: 100, nextBeforeOrdinal: 100, hasMore: true,
		});
		const response = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockImplementationOnce(() => response.promise);
		const { controller, viewport } = scrolling(transcript);
		const layout = Promise.withResolvers<'settled'>();
		viewport.waitForLayout.mockReturnValue(layout.promise);
		const load = transcript.loadEarlierPage(chatId);
		let finished = false;
		const navigation = controller.loadEarlierPageForNavigator(chatId).then(result => {
			finished = true;
			return result;
		});
		response.resolve({
			chatId, transcriptViewId: viewId, historyState: { kind: 'complete' },
			messages: Array.from({ length: 50 }, (_, index) => assistant(index + 50)),
			lastOrdinal: 100, pageOldestOrdinal: 50, pageNewestOrdinal: 99,
			nextBeforeOrdinal: 50, hasMore: true, limit: 50, resendCandidates: [],
		});
		try {
			await load;
			await vi.waitFor(() => expect(viewport.waitForLayout).toHaveBeenCalledOnce());
			expect(finished).toBe(false);
			layout.resolve('settled');
			expect(await navigation).toBe('loaded');
			expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
			expect(controller.isPinnedToBottom).toBe(true);
		} finally {
			layout.resolve('settled');
			await navigation;
			controller.destroy();
			cache.flush();
		}
	});

	it('seeds two mounted panels from a raw pre-panel fallback and independently fills their real edges', async () => {
		const { registry, cache, mount } = panelFixture();
		const entries = [
			input(1),
			...Array.from({ length: 350 }, (_, index) => tool(index + 2)),
			assistant(352),
		];
		vi.mocked(getChatMessages).mockResolvedValue({
			chatId,
			transcriptViewId: viewId,
			historyState: { kind: 'complete' },
			messages: entries.slice(-100),
			lastOrdinal: 352,
			pageNewestOrdinal: 352,
			pageOldestOrdinal: 253,
			nextBeforeOrdinal: 253,
			hasMore: true,
			limit: 100,
			resendCandidates: [],
		});
		const current = new CurrentConversationPanelTranscript({
			panels: registry,
			getSelectedChatId: () => chatId,
		});
		try {
			current.activateChat(chatId);
			await current.loadMessages(chatId, { minimumLimit: 100 });
			expect(getCombinedChatMessages).not.toHaveBeenCalled();
			installHistory(entries, 200);
			mount('left', 'right');
			for (const panel of registry.panelsForChat(chatId)) {
				expect(panel.transcript.hasPendingAnchorDemand('earlier')).toBe(true);
				expect(panel.transcript.nextBeforeOrdinal).toBe(253);
				await panel.transcript.loadEarlierPage(chatId);
				expect(panel.transcript.entries).toEqual(entries);
			}
			expect(cache.get(chatId)?.messages).toHaveLength(100);
		} finally {
			registry.destroy();
			cache.flush();
		}
	});

	it('gives peers mounting between chunks provisional coverage, never a later chunk across a gap', async () => {
		const { registry, cache, mount } = panelFixture();
		const entries = Array.from({ length: 601 }, (_, index) => tool(index + 1));
		const read = installHistory(entries, 200);
		try {
			mount('left');
			await registry.loadChatSnapshot(chatId);
			const left = registry.panel('chat-view:window-left')!.transcript;
			const heldChunk = Promise.withResolvers<TranscriptAnchorPage>();
			vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => heldChunk.promise);
			const load = left.loadEarlierPage(chatId);
			const request = vi.mocked(getCombinedChatMessages).mock.calls.at(-1)![0];
			mount('left', 'right', 'third');
			for (const panel of registry.panelsForChat(chatId).slice(1)) {
				expect(panel.transcript.nextBeforeOrdinal).toBe(502);
				await panel.transcript.loadEarlierPage(chatId);
				expect(panel.transcript.entries).toEqual(entries);
			}
			heldChunk.resolve(read(request));
			await load;
			expect(left.entries).toEqual(entries);
			expect(new Set(left.entries.map((entry) => entry.ordinal)).size).toBe(601);
		} finally {
			registry.destroy();
			cache.flush();
		}
	});

	it('preserves shared resend freshness through registry commit fanout while the first snapshot is held', async () => {
		const { registry, cache, mount } = panelFixture();
		cache.replace(chatId, viewId, [input(1)], 1, null);
		mount('left', 'right');
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		try {
			const load = registry.loadChatSnapshot(chatId);
			registry.applyCommittedBatch({
				chatId,
				transcriptViewId: viewId,
				messages: [assistant(2)],
				firstOrdinal: 2,
				lastOrdinal: 2,
				resendCandidates: [],
				noticeRevision: 0,
			});
			response.resolve({
				...history([input(1)])({ chatId, direction: 'backward', anchorsRemaining: 100 }),
				resendCandidates: [{ ordinal: 1, content: 'Synthetic input', attachmentNames: [] }],
			});
			await load;
			for (const panel of registry.panelsForChat(chatId)) {
				expect(panel.transcript.resendCandidates).toEqual([]);
				expect(panel.transcript.lastOrdinal).toBe(2);
			}
			expect(cache.readAppliedCursor(chatId)?.lastOrdinal).toBe(2);
		} finally {
			registry.destroy();
			cache.flush();
		}
	});

	it('upgrades a manual join of held coverage without unpinning or replacing its gate', async () => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 601 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const second = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => second.promise);
		const { controller } = scrolling(transcript);
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			const join = controller.requestPage('earlier', 'button');
			expect(controller.isPinnedToBottom).toBe(true);
			controller.setPinnedToBottom(false);
			second.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			expect(await join).toBe('loaded');
			await fill;
			expect(transcript.entries).toHaveLength(601);
			expect(transcript.nextBeforeOrdinal).toBeNull();
		} finally {
			controller.destroy();
		}
	});

	it('pauses a detached activation after a chunk makes the viewport overflow', async () => {
		const { transcript } = fixture();
		installHistory(Array.from({ length: 601 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const { controller, viewport } = scrolling(transcript);
		viewport.readViewportFill.mockImplementation(() =>
			transcript.entries.length < 400 ? 'underfilled' : 'overflow',
		);
		controller.setPinnedToBottom(false);
		try {
			await controller.fillUnderfilledViewport();
			expect(transcript.entries).toHaveLength(400);
			expect(transcript.nextBeforeOrdinal).toBe(202);
			expect(transcript.hasPendingAnchorDemand('earlier')).toBe(true);
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(2);
			expect(viewport.scrollToEnd).not.toHaveBeenCalled();
		} finally {
			controller.destroy();
		}
	});

	it('waits for a new native gesture to settle before applying a held continuation', async () => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 401 }, (_, index) => tool(index + 1)), 200);
		await transcript.loadMessages(chatId);
		const second = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => second.promise);
		const { controller } = scrolling(transcript);
		try {
			const fill = controller.fillUnderfilledViewport();
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			controller.noteNativeTouchLifecycle('move');
			second.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			await Promise.resolve();
			await Promise.resolve();
			expect(transcript.entries).toHaveLength(200);
			controller.noteNativeTouchLifecycle('end');
			await fill;
			expect(transcript.entries).toHaveLength(401);
		} finally {
			controller.destroy();
		}
	});

	it('lets an explicit opposite-direction page preempt transport without losing the earlier budget', async () => {
		const { transcript } = fixture();
		const read = installHistory(Array.from({ length: 601 }, (_, index) => tool(index + 1)), 200);
		transcript.replaceGeneration(chatId, viewId, [tool(301)], {
			lastOrdinal: 601,
			pageOldestOrdinal: 301,
			pageNewestOrdinal: 301,
			nextBeforeOrdinal: 301,
			hasMore: true,
		});
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const { controller } = scrolling(transcript);
		try {
			const earlier = controller.requestPage('earlier', 'button');
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledOnce());
			expect(await controller.requestPage('later', 'button')).toBe('loaded');
			response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
			expect(await earlier).toBe('invalidated');
			expect(transcript.nextBeforeOrdinal).toBe(301);
			expect(transcript.loadedThroughOrdinal).toBe(601);
			expect(await controller.requestPage('earlier', 'button')).toBe('loaded');
			expect(transcript.entries).toHaveLength(601);
		} finally {
			controller.destroy();
		}
	});

	it('recaptures a fresh forward watermark after exhausting W below the observed head', async () => {
		const { transcript } = fixture();
		const entries = Array.from({ length: 401 }, (_, index) => tool(index + 1));
		installHistory(entries, 200);
		await transcript.loadMessages(chatId);
		await transcript.navigateToWindow(chatId, 'initial');
		installHistory([...entries, assistant(402)], 200);
		await transcript.loadLaterPage(chatId);
		expect(transcript.loadedThroughOrdinal).toBe(401);
		expect(transcript.hasLaterMessages).toBe(true);
		expect(transcript.hasPendingAnchorDemand('later')).toBe(false);
		await transcript.loadLaterPage(chatId);
		expect(vi.mocked(getCombinedChatMessages).mock.calls.at(-1)![0]).toMatchObject({
			cursorOrdinal: 401,
			anchorsRemaining: 100,
		});
		expect(
			vi.mocked(getCombinedChatMessages).mock.calls.at(-1)![0].watermarkOrdinal,
		).toBeUndefined();
		expect(transcript.loadedThroughOrdinal).toBe(402);
		expect(transcript.hasLaterMessages).toBe(false);
	});

	function detached() {
		const value = fixture();
		value.transcript.replaceGeneration(chatId, viewId, [assistant(100)], {
			lastOrdinal: 1001,
			pageNewestOrdinal: 150,
			pageOldestOrdinal: 100,
			nextBeforeOrdinal: 100,
			hasMore: true,
		});
		value.cache.replace(chatId, viewId, [assistant(1000)], 1001, 1000);
		return value;
	}

	it.each(['latest', 'initial'] as const)(
		'keeps the resident window through hidden-only %s navigation',
		async (target) => {
			const { transcript } = detached();
			const read = installHistory([input(2), assistant(1000)], 1, 1001);
			const publicResponse = Promise.withResolvers<TranscriptAnchorPage>();
			vi.mocked(getCombinedChatMessages)
				.mockImplementationOnce(async (request) => read(request))
				.mockImplementationOnce(() => publicResponse.promise);
			const navigation = transcript.navigateToWindow(chatId, target);
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([100]);
			expect(transcript.loadStatus).toBe('loaded');
			publicResponse.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			expect(await navigation).toBe('loaded');
			expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([
				target === 'latest' ? 1000 : 2,
			]);
		},
	);

	it('allows Start to supersede held Latest and keeps Start out of the recent receipt cache', async () => {
		const { transcript, cache } = detached();
		const read = installHistory([input(1), assistant(1000)], 200, 1001);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const latest = transcript.navigateToWindow(chatId, 'latest');
		expect(await transcript.navigateToWindow(chatId, 'initial')).toBe('loaded');
		expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([1]);
		expect(cache.readAppliedCursor(chatId)?.lastOrdinal).toBe(1001);
		response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
		expect(await latest).toBe('invalidated');
		expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([1]);
	});

	it('allows row navigation to supersede held Latest without waiting for its response', async () => {
		const { transcript } = detached();
		const read = installHistory([input(1), assistant(1000)], 200, 1001);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const latest = transcript.navigateToWindow(chatId, 'latest');
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			chatId,
			transcriptViewId: viewId,
			historyState: { kind: 'complete' },
			messages: [assistant(50)],
			lastOrdinal: 1001,
			pageOldestOrdinal: 50,
			pageNewestOrdinal: 50,
			nextBeforeOrdinal: 50,
			hasMore: true,
			limit: 50,
			resendCandidates: [],
		});
		expect(
			await transcript.navigateToRow(
				{ chatId, transcriptViewId: viewId, ordinal: 50 },
				new AbortController().signal,
				() => true,
			),
		).toBe('loaded');
		response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
		expect(await latest).toBe('invalidated');
		expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([50]);
	});

	it('does not drain a snapshot-owned buffer when superseded Latest finally exits', async () => {
		const { transcript } = detached();
		const read = installHistory([input(1), assistant(1000)], 200, 1001);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const latest = transcript.navigateToWindow(chatId, 'latest');
		const epoch = transcript.beginSnapshotLoad();
		transcript.applyMessages(chatId, viewId, [assistant(1002)], 1002, 1002);
		response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
		expect(await latest).toBe('invalidated');
		expect(transcript.lastOrdinal).toBe(1001);
		expect(
			transcript.setFromPage(
				chatId,
				{
					transcriptViewId: viewId,
					messages: [assistant(1000)],
					lastOrdinal: 1001,
					pageOldestOrdinal: 1000,
					pageNewestOrdinal: 1001,
					nextBeforeOrdinal: 1000,
					hasMore: true,
				},
				epoch,
			),
		).toBe('applied');
		expect(transcript.lastOrdinal).toBe(1002);
	});

	it('drains a navigation-owned buffer synchronously on cancellation and resumes normal WS delivery', async () => {
		const { transcript } = detached();
		const read = installHistory([input(1), assistant(1000)], 200, 1001);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const latest = transcript.navigateToWindow(chatId, 'latest');
		transcript.applyMessages(chatId, viewId, [assistant(1002)], 1002, 1002);
		transcript.invalidatePendingWindowNavigation();
		expect(transcript.lastOrdinal).toBe(1002);
		transcript.applyMessages(chatId, viewId, [assistant(1003)], 1003, 1003);
		expect(transcript.lastOrdinal).toBe(1003);
		response.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
		expect(await latest).toBe('invalidated');
	});

	it('reloads after a cancelled navigation cannot drain its buffered replacement view', async () => {
		const { transcript } = detached();
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		const oldRead = history([input(1), assistant(1000)], 200, 1001);
		vi.mocked(getCombinedChatMessages)
			.mockImplementationOnce(() => response.promise)
			.mockImplementation(async request => ({ ...history([input(1)])(request), transcriptViewId: 'replacement-view' }));
		const latest = transcript.navigateToWindow(chatId, 'latest');
		transcript.applyMessages(chatId, 'replacement-view', [input(1)], 1, 1);
		transcript.invalidatePendingWindowNavigation();
		await vi.waitFor(() => expect(transcript.transcriptViewId).toBe('replacement-view'));
		expect(transcript.lastOrdinal).toBe(1);
		response.resolve(oldRead(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]));
		expect(await latest).toBe('invalidated');
		expect(transcript.applyMessages(chatId, 'replacement-view', [assistant(2)], 2, 2)).toBe('applied');
	});

	it('paints the first chunk, then retains a prompt and 350 tools through a loader-owned continuation', async () => {
		const { transcript } = fixture();
		const entries = [
			input(1),
			...Array.from({ length: 350 }, (_, i) => tool(i + 2)),
			assistant(352),
		];
		const read = installHistory(entries, 200);
		await transcript.loadMessages(chatId);
		expect(transcript.entries).toHaveLength(200);
		expect(transcript.isLoadingMessages).toBe(false);
		expect(transcript.hasPendingAnchorDemand('earlier')).toBe(true);
		const second = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => second.promise);
		const load = transcript.loadEarlierPage(chatId);
		const join = transcript.loadEarlierPage(chatId);
		expect(getCombinedChatMessages).toHaveBeenCalledTimes(2);
		const next = vi.mocked(getCombinedChatMessages).mock.calls[1]![0];
		expect(next).toMatchObject({ watermarkOrdinal: 352, cursorOrdinal: 153, anchorsRemaining: 99 });
		second.resolve(read(next));
		expect(await load).toBe('loaded');
		expect(await join).toBe('loaded');
		expect(transcript.entries).toEqual(entries);
		expect(transcript.visibleRows).toHaveLength(352);
		expect(transcript.hasPendingAnchorDemand('earlier')).toBe(false);
	});

	it('keeps applied coverage and its remaining budget across errors and transport suspension', async () => {
		const { transcript } = fixture();
		const read = installHistory(
			Array.from({ length: 601 }, (_, i) => (i === 600 ? assistant(i + 1) : tool(i + 1))),
			200,
		);
		await transcript.loadMessages(chatId);
		vi.mocked(getCombinedChatMessages)
			.mockImplementationOnce(async (request) => read(request))
			.mockRejectedValueOnce(new Error('Synthetic network failure'));
		expect(await transcript.loadEarlierPage(chatId)).toBe('failed');
		expect(transcript.nextBeforeOrdinal).toBe(202);
		expect(transcript.loadStatus).toBe('loaded');
		expect(transcript.pageStates.earlier.status).toBe('error');
		transcript.invalidatePendingHistoryLoad();
		expect(transcript.pageStates.earlier.status).toBe('error');
		await transcript.loadEarlierPage(chatId);
		expect(vi.mocked(getCombinedChatMessages).mock.calls[3]![0]).toMatchObject({
			cursorOrdinal: 202,
			anchorsRemaining: 99,
			watermarkOrdinal: 601,
		});
		expect(transcript.entries).toHaveLength(601);
	});

	it.each(['held', 'error'] as const)('preserves combined demand through parking and background commits (%s)', async interruption => {
		const { cache, registry, mount, switchChat } = panelFixture({ retainInactive: true });
		const entries = [input(1), ...Array.from({ length: 599 }, (_, index) => tool(index + 2)), assistant(601)];
		const read = installHistory(entries, 200);
		mount('left');
		await registry.loadChatSnapshot(chatId);
		const transcript = registry.panel('chat-view:window-left')!.transcript;
		const held = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => held.promise);
		const pending = transcript.loadEarlierPage(chatId);
		const request = vi.mocked(getCombinedChatMessages).mock.calls.at(-1)![0];
		try {
			expect(request).toEqual({ chatId, transcriptViewId: viewId, direction: 'backward',
				cursorOrdinal: 402, watermarkOrdinal: 601, anchorsRemaining: 99 });
			if (interruption === 'error') {
				held.reject(new Error('Synthetic continuation failure'));
				expect(await pending).toBe('failed');
			}
			cache.replace('synthetic-other-chat', 'synthetic-other-view', [assistant(1)], 1, null);
			switchChat('synthetic-other-chat');
			expect(registry.hasInactiveWindow(chatId)).toBe(true);
			expect(registry.applyCommittedBatch({ chatId, transcriptViewId: viewId,
				firstOrdinal: 602, lastOrdinal: 602, messages: [assistant(602)],
				resendCandidates: [], noticeRevision: 0 })).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });
			if (interruption === 'held') {
				held.resolve(read(request));
				expect(await pending).toBe('invalidated');
			}
			switchChat(chatId);
			expect(registry.panel('chat-view:window-left')!.transcript).toBe(transcript);
			expect(transcript.entries).toEqual([...entries.slice(401), assistant(602)]);
			expect(cache.get(chatId)!.messages).toHaveLength(100);
			expect(transcript.hasPendingAnchorDemand('earlier')).toBe(true);
			expect(transcript.pageStates.earlier.status).toBe(interruption === 'error' ? 'error' : 'idle');
			const panel = registry.panel('chat-view:window-left')!;
			const viewport = testViewport();
			panel.attachPresentation({
				getScrollContainer: () => null,
				getViewport: () => viewport,
				getQueueContainer: () => undefined,
				captureRestoreTarget: () => ({ kind: 'end' }),
				closeTransients: vi.fn(),
			});
			installHistory([...entries, assistant(602)], 200);
			panel.completeInitialBottomRestore();
			if (interruption === 'error') {
				await panel.scroll.fillUnderfilledViewport();
				expect(getCombinedChatMessages).toHaveBeenCalledTimes(2);
				await panel.scroll.requestPage('earlier', 'button');
			}
			await vi.waitFor(() => expect(transcript.hasPendingAnchorDemand('earlier')).toBe(false));
			expect(vi.mocked(getCombinedChatMessages).mock.calls[2]![0]).toEqual(request);
			expect(transcript.entries).toEqual([...entries, assistant(602)]);
			expect(transcript.hasPendingAnchorDemand('earlier')).toBe(false);
			expect(transcript.pageStates.earlier.status).toBe('idle');
		} finally {
			held.resolve(read(request));
			await pending;
		}
	});

	it('treats hidden-only loader chunks as raw progress without changing public rows', async () => {
		const { transcript } = fixture();
		const read = installHistory([assistant(601)], 200);
		await transcript.loadMessages(chatId);
		const before = transcript.entries;
		const gate = vi.fn().mockResolvedValueOnce('apply').mockResolvedValueOnce('invalidated');
		expect(await transcript.loadEarlierPage(chatId, { applicationGate: gate })).toBe('invalidated');
		expect(transcript.entries).toEqual(before);
		expect(transcript.nextBeforeOrdinal).toBe(202);
		expect(transcript.hasPendingAnchorDemand('earlier')).toBe(true);
		expect(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]).messages).toEqual([]);
		expect(await transcript.loadEarlierPage(chatId)).toBe('loaded');
		expect(vi.mocked(getCombinedChatMessages).mock.calls[3]![0]).toEqual({
			chatId, transcriptViewId: viewId, direction: 'backward', cursorOrdinal: 202,
			watermarkOrdinal: 601, anchorsRemaining: 99,
		});
		expect(transcript.entries).toEqual(before);
		expect(transcript.hasEarlierMessages).toBe(false);
	});

	it('keeps hidden-only first installation loading until a public chunk arrives', async () => {
		const { transcript } = fixture();
		const read = installHistory([input(1)], 1, 3);
		const hidden = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages)
			.mockImplementationOnce(async request => read(request))
			.mockImplementationOnce(() => hidden.promise);
		const load = transcript.loadMessages(chatId);
		try {
			await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
			expect(transcript.loadStatus).toBe('loading');
			expect(transcript.entries).toEqual([]);
			hidden.resolve(read(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]));
			await load;
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(3);
			expect(transcript.entries).toEqual([input(1)]);
			expect(transcript.loadStatus).toBe('loaded');
			expect(transcript.lastOrdinal).toBe(3);
			expect(transcript.hasEarlierMessages).toBe(false);
		} finally {
			hidden.resolve(read({ chatId, direction: 'backward', transcriptViewId: viewId,
				cursorOrdinal: 3, watermarkOrdinal: 3, anchorsRemaining: 100 }));
			await load;
		}
	});

	it('reseeds cache-gap recovery from the raw edge rather than the first public row', async () => {
		const { cache, transcript } = fixture();
		installHistory(Array.from({ length: 200 }, (_, index) => tool(index + 1)), 100);
		await transcript.loadMessages(chatId);
		expect(transcript.hasPendingAnchorDemand('earlier')).toBe(true);
		cache.replace(chatId, viewId, Array.from({ length: 50 }, (_, index) => tool(index + 251)), 300, 201);
		expect(transcript.applyMessages(chatId, viewId, [assistant(301)], 301, 301)).toBe('applied');
		expect(transcript.nextBeforeOrdinal).toBe(201);
		expect(transcript.entries[0]!.ordinal).toBe(251);
		installHistory([input(1), assistant(301)]);
		await transcript.loadEarlierPage(chatId);
		expect(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]).toEqual({
			chatId, transcriptViewId: viewId, direction: 'backward', cursorOrdinal: 201,
			anchorsRemaining: 99,
		});
		expect(transcript.entries[0]).toEqual(input(1));
	});

	it('gates every chunk freshly and never advances a rejected raw interval', async () => {
		const { transcript } = fixture();
		installHistory(Array.from({ length: 601 }, (_, i) => tool(i + 1)), 200);
		await transcript.loadMessages(chatId);
		const gate = vi.fn().mockResolvedValueOnce('apply').mockResolvedValueOnce('invalidated');
		expect(await transcript.loadEarlierPage(chatId, { applicationGate: gate })).toBe('invalidated');
		expect(gate).toHaveBeenCalledTimes(2);
		expect(transcript.nextBeforeOrdinal).toBe(202);
		await transcript.loadEarlierPage(chatId);
		expect(vi.mocked(getCombinedChatMessages).mock.calls[3]![0].cursorOrdinal).toBe(202);
	});

	it('historical H changes do not detach live presentation or alter resend overlays', async () => {
		const { transcript } = fixture();
		const entries = Array.from({ length: 350 }, (_, i) => tool(i + 1));
		installHistory(entries, 200);
		await transcript.loadMessages(chatId);
		transcript.setResendCandidates([
			{ ordinal: 1, content: 'Synthetic pending input', attachmentNames: [] },
		]);
		installHistory([...entries, assistant(351)]);
		await transcript.loadEarlierPage(chatId);
		expect(transcript.lastOrdinal).toBe(350);
		expect(transcript.hasLaterMessages).toBe(false);
		expect(transcript.resendCandidates).toHaveLength(1);
	});

	it('drains buffered live commits after first install', async () => {
		const { transcript } = fixture();
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const load = transcript.loadMessages(chatId);
		transcript.applyMessages(chatId, viewId, [assistant(2)], 2, 2);
		response.resolve(history([input(1)])({ chatId, direction: 'backward', anchorsRemaining: 100 }));
		await load;
		expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([1, 2]);
		expect(transcript.lastOrdinal).toBe(2);
	});

	it('counts only older resident anchors, excluding overlap and buffered live input', async () => {
		const { transcript } = fixture();
		const resident = Array.from({ length: 60 }, (_, i) => assistant(i + 100));
		transcript.replaceGeneration(chatId, viewId, resident, {
			lastOrdinal: 159,
			pageOldestOrdinal: 100,
			nextBeforeOrdinal: 100,
			hasMore: true,
		});
		const entries = Array.from({ length: 160 }, (_, i) => assistant(i + 1));
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const load = transcript.loadMessages(chatId);
		transcript.applyMessages(chatId, viewId, [input(161)], 161, 161);
		response.resolve(
			history(entries, 20)({ chatId, direction: 'backward', anchorsRemaining: 100 }),
		);
		await load;
		installHistory([...entries, input(161)]);
		await transcript.loadEarlierPage(chatId);
		expect(vi.mocked(getCombinedChatMessages).mock.calls[1]![0]).toEqual({
			chatId,
			transcriptViewId: viewId,
			direction: 'backward',
			cursorOrdinal: 100,
			anchorsRemaining: 39,
		});
	});

	it('preserves a detached disjoint interval and stops that snapshot continuation', async () => {
		const { transcript } = fixture();
		transcript.replaceGeneration(chatId, viewId, [input(1)], {
			lastOrdinal: 1000,
			pageNewestOrdinal: 100,
			pageOldestOrdinal: 1,
			nextBeforeOrdinal: null,
			hasMore: false,
		});
		installHistory([input(1), assistant(1000)], 200);
		await transcript.loadMessages(chatId);
		expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([1]);
		expect(transcript.loadedThroughOrdinal).toBe(100);
		expect(transcript.hasPendingAnchorDemand('earlier')).toBe(false);
		expect(getCombinedChatMessages).toHaveBeenCalledTimes(1);
	});

	it('recovers a same-view rollback through replacement, not a max-head merge', async () => {
		const { transcript, cache } = fixture();
		transcript.replaceGeneration(
			chatId,
			viewId,
			Array.from({ length: 100 }, (_, i) => assistant(i + 2)),
			{ lastOrdinal: 101, pageOldestOrdinal: 2, nextBeforeOrdinal: 2, hasMore: true },
		);
		installHistory(Array.from({ length: 80 }, (_, i) => assistant(i + 1)));
		vi.mocked(getCombinedChatMessages).mockRejectedValueOnce(
			new ApiError(409, 'Synthetic rollback', 'TRANSCRIPT_CURSOR_AHEAD'),
		);
		expect(await transcript.loadEarlierPage(chatId)).toBe('invalidated');
		expect(transcript.lastOrdinal).toBe(80);
		expect(transcript.entries.at(-1)?.ordinal).toBe(80);
		expect(cache.readAppliedCursor(chatId)?.lastOrdinal).toBe(80);
	});

	it.each(['snapshot', 'cached snapshot', 'earlier', 'later', 'initial', 'latest'] as const)(
		'recovers a successful lower-head %s response before retaining lost rows', async operation => {
			const { transcript, cache } = fixture();
			const original = Array.from({ length: 100 }, (_, index) => assistant(index + 1));
			const retained = original.slice(0, 80);
			const detached = operation === 'later' || operation === 'latest' || operation === 'cached snapshot';
			const hasEarlier = operation === 'earlier' || operation === 'initial';
			const resident = detached ? retained : original.slice(hasEarlier ? 30 : 0);
			transcript.replaceGeneration(chatId, viewId, resident, {
				lastOrdinal: operation === 'cached snapshot' ? 80 : 100,
				pageNewestOrdinal: detached ? 80 : 100,
				pageOldestOrdinal: resident[0]!.ordinal,
				nextBeforeOrdinal: hasEarlier ? 31 : null,
				hasMore: hasEarlier,
			});
			cache.replace(chatId, viewId, original, 100, null);
			installHistory(retained);
			const recovery = vi.spyOn(transcript, 'recoverTranscriptCursorAhead');
			switch (operation) {
				case 'snapshot':
				case 'cached snapshot':
					await transcript.loadMessages(chatId);
					break;
				case 'earlier':
					await transcript.loadEarlierPage(chatId);
					break;
				case 'later':
					await transcript.loadLaterPage(chatId);
					break;
				default:
					await transcript.navigateToWindow(chatId, operation);
			}
			expect(getCombinedChatMessages).toHaveBeenCalled();
			expect(recovery).toHaveBeenCalledExactlyOnceWith(chatId, viewId);
			expect(transcript.entries).toEqual(retained);
			expect(transcript.lastOrdinal).toBe(80);
			expect(transcript.loadedThroughOrdinal).toBe(80);
			expect(transcript.hasLaterMessages).toBe(false);
			expect(cache.readAppliedCursor(chatId)?.lastOrdinal).toBe(80);
			cache.flush();
		},
	);

	it.each(['snapshot', 'earlier', 'later', 'initial', 'latest'] as const)(
		'keeps live appends newer than an in-flight %s response without rollback recovery', async operation => {
			const { transcript, cache } = fixture();
			const original = Array.from({ length: 100 }, (_, index) => assistant(index + 1));
			const detached = operation === 'later' || operation === 'latest';
			const resident = detached ? original.slice(0, 80) : original.slice(30);
			transcript.replaceGeneration(chatId, viewId, resident, {
				lastOrdinal: 100,
				pageNewestOrdinal: detached ? 80 : 100,
				pageOldestOrdinal: resident[0]!.ordinal,
				nextBeforeOrdinal: detached ? null : 31,
				hasMore: !detached,
			});
			cache.replace(chatId, viewId, original, 100, null);
			const read = installHistory(original);
			const response = Promise.withResolvers<TranscriptAnchorPage>();
			vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
			const recovery = vi.spyOn(transcript, 'recoverTranscriptCursorAhead');
			let load: Promise<unknown>;
			switch (operation) {
				case 'snapshot': load = transcript.loadMessages(chatId); break;
				case 'earlier': load = transcript.loadEarlierPage(chatId); break;
				case 'later': load = transcript.loadLaterPage(chatId); break;
				default: load = transcript.navigateToWindow(chatId, operation);
			}
			const page = read(vi.mocked(getCombinedChatMessages).mock.calls[0]![0]);
			transcript.applyMessages(chatId, viewId, [assistant(101)], 101, 101);
			response.resolve(page);
			await load;
			expect(recovery).not.toHaveBeenCalled();
			expect(transcript.lastOrdinal).toBe(101);
			expect(cache.readAppliedCursor(chatId)?.lastOrdinal).toBe(101);
			if (operation !== 'later') expect(transcript.entries.at(-1)?.ordinal).toBe(101);
			cache.flush();
		},
	);

	it('replaces same-view lost tails in every mounted panel and the shared cache', async () => {
		const { cache, overlays, registry, mount } = panelFixture({ maxHiddenEntries: 1, retainInactive: true });
		const original = Array.from({ length: 100 }, (_, index) => index === 79 ? input(80) : assistant(index + 1));
		const retained = original.slice(0, 80);
		const candidates = [{ ordinal: 80, content: 'Synthetic input 80', attachmentNames: [] }];
		installHistory(original, 50);
		mount('left', 'right', 'parked');
		const replacement = Promise.withResolvers<TranscriptAnchorPage>();
		const replacementStarted = Promise.withResolvers<void>();
		let load: ReturnType<ActiveTranscriptState['loadMessages']> | undefined;
		try {
			await registry.loadChatSnapshot(chatId);
			const left = registry.panel('chat-view:window-left')!.transcript;
			const right = registry.panel('chat-view:window-right')!.transcript;
			const parked = registry.panel('chat-view:window-parked')!.transcript;
			expect(left.lastOrdinal).toBe(100);
			expect(right.lastOrdinal).toBe(100);
			for (const transcript of [left, right, parked]) expect(transcript.hasPendingAnchorDemand('earlier')).toBe(true);
			mount('left', 'right');
			expect(registry.hasInactiveWindow(chatId)).toBe(true);
			registry.publishSnapshotResendCandidates(chatId, candidates, { transcriptViewId: viewId, lastOrdinal: 100 });
			registry.excludeResendCandidate(chatId, 80);
			registry.upsertOptimisticInput(chatId, { chatId, clientMessageId: 'synthetic-pending',
				content: 'Synthetic pending input', createdAt: time, delivery: 'pending' });
			registry.appendServerNotice(chatId, 'info', 'Synthetic obsolete notice');
			const overlay = overlays.forChat(chatId);
			expect(overlay.notices).toHaveLength(1);
			expect(overlay.optimisticInputs).toHaveLength(1);
			expect(overlay.optimisticAfterOrdinals.get('synthetic-pending')).toBe(100);
			expect(overlay.resendCandidates).toEqual(candidates);
			expect(overlay.includedResendCandidates).toEqual([]);
			cache.flush();
			// Injects a cache miss independently of visible-panel retention.
			cache.setVisibleChatIds([]);
			cache.replace('synthetic-other-chat', 'synthetic-other-view', [assistant(1)], 1, null);
			expect(cache.get(chatId)).toBeNull();
			const replay = registry.beginReconnectReplay(chatId, viewId);
			const read = history(retained);
			vi.mocked(getCombinedChatMessages)
				.mockImplementation(async request => ({ ...read(request), resendCandidates: candidates }))
				.mockImplementationOnce(async request => read(request))
				.mockImplementationOnce(() => { replacementStarted.resolve(); return replacement.promise; });
			load = left.loadMessages(chatId);
			await replacementStarted.promise;
			expect(registry.hasInactiveWindow(chatId)).toBe(false);
			expect(cache.hydrate(chatId)).toBeNull();
			for (const transcript of [left, right]) {
				expect(transcript.entries).toEqual([]);
				expect(transcript.hasPendingAnchorDemand('earlier')).toBe(false);
			}
			expect(overlay.notices).toEqual([]);
			expect(overlay.optimisticInputs).toEqual([]);
			expect(overlay.optimisticAfterOrdinals.size).toBe(0);
			expect(overlay.resendCandidates).toEqual([]);
			const commit = { chatId, transcriptViewId: viewId, firstOrdinal: 81, lastOrdinal: 81,
				messages: [assistant(81)], resendCandidates: [], noticeRevision: 0 };
			expect(registry.applyReconnectReplayPage(replay, chatId, commit)).toBe('stale');
			expect(registry.finishReconnectReplay(replay, chatId)).toBe('stale');
			replacement.resolve({ ...read({ chatId, direction: 'backward', anchorsRemaining: 100 }), resendCandidates: candidates });
			await load;
			for (const transcript of [left, right]) {
				expect(transcript.entries).toEqual(retained);
				expect(transcript.lastOrdinal).toBe(80);
				expect(transcript.loadedThroughOrdinal).toBe(80);
				expect(transcript.hasLaterMessages).toBe(false);
			}
			expect(cache.get(chatId)?.messages).toEqual(retained);
			expect(cache.readAppliedCursor(chatId)?.lastOrdinal).toBe(80);
			expect(overlay.includedResendCandidates).toEqual(candidates);
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(3);
			cache.flush();
			mount('left', 'right', 'parked');
			const remounted = registry.panel('chat-view:window-parked')!.transcript;
			expect(remounted).not.toBe(parked);
			expect(remounted.entries).toEqual(retained);
			expect(registry.applyCommittedBatch(commit)).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });
			for (const transcript of [left, right, remounted]) expect(transcript.entries.at(-1)).toEqual(assistant(81));
		} finally {
			replacement.resolve(history(retained)({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			await load;
		}
	});

	it.each(['cold', 'same-view recovery'] as const)('preserves a live commit arriving during a held snapshot (%s)', async origin => {
		const { cache, registry, mount } = panelFixture({ retainInactive: true });
		if (origin === 'same-view recovery') {
			installHistory(Array.from({ length: 100 }, (_, index) => assistant(index + 1)));
			mount('left', 'right', 'parked');
			await registry.loadChatSnapshot(chatId);
			mount('left', 'right');
		}
		const selected = new CurrentConversationPanelTranscript({ panels: registry, getSelectedChatId: () => chatId });
		const retained = Array.from({ length: 80 }, (_, index) => assistant(index + 1));
		const replacement = Promise.withResolvers<TranscriptAnchorPage>();
		const replacementStarted = Promise.withResolvers<void>();
		const read = history(retained);
		vi.mocked(getCombinedChatMessages).mockImplementation(async request => history([...retained, assistant(81)])(request));
		if (origin === 'same-view recovery') vi.mocked(getCombinedChatMessages).mockImplementationOnce(async request => read(request));
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => { replacementStarted.resolve(); return replacement.promise; });
		if (origin === 'cold') {
			cache.replace(chatId, viewId, [], 0, null);
			mount('left', 'right');
			cache.remove(chatId);
		}
		const recovery = selected.loadMessages(chatId, { purpose: 'activation' });
		let reload: ReturnType<typeof selected.loadMessages> | undefined;
		try {
			await replacementStarted.promise;
			expect(vi.mocked(getCombinedChatMessages).mock.calls.at(-1)![0].purpose).toBe('activation');
			const result = selected.applyMessages(chatId, viewId, [assistant(81)], 81, 81);
			if (result !== 'applied') reload = selected.loadMessages(chatId);
			replacement.resolve(read({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			await recovery;
			await reload;
			mount('left', 'right', 'parked');
			for (const panel of registry.panelsForChat(chatId)) {
				expect(panel.transcript.entries).toEqual([...retained, assistant(81)]);
				expect(panel.transcript.loadedThroughOrdinal).toBe(81);
			}
			expect(cache.get(chatId)?.messages).toEqual([...retained, assistant(81)]);
			expect(cache.readAppliedCursor(chatId)?.lastOrdinal).toBe(81);
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(origin === 'cold' ? 2 : 4);
			expect(vi.mocked(getCombinedChatMessages).mock.calls.at(-1)![0]).toEqual({
				chatId, direction: 'backward', anchorsRemaining: 100,
			});
		} finally {
			replacement.resolve(read({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			await recovery;
			await reload;
		}
	});

	it.each(['no-peer', 'peer', 'second-removal'] as const)('keeps refresh responsibility when the loader is hidden (%s)', async outcome => {
		const { cache, registry, mount } = panelFixture({ retainInactive: true });
		const entries = Array.from({ length: 81 }, (_, index) => assistant(index + 1));
		const snapshot = Promise.withResolvers<TranscriptAnchorPage>();
		const refresh = Promise.withResolvers<TranscriptAnchorPage>();
		const handoff = Promise.withResolvers<TranscriptAnchorPage>();
		const started = Promise.withResolvers<void>();
		const handoffStarted = Promise.withResolvers<void>();
		const remainingPeer = outcome !== 'no-peer';
		const succeeds = outcome === 'peer';
		installHistory(entries);
		vi.mocked(getCombinedChatMessages)
			.mockImplementationOnce(() => snapshot.promise)
			.mockImplementationOnce(() => { started.resolve(); return refresh.promise; });
		if (outcome === 'second-removal') vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => {
			handoffStarted.resolve();
			return handoff.promise;
		});
		const peers = outcome === 'second-removal' ? ['right', 'third'] : remainingPeer ? ['right'] : [];
		mount('left', ...peers);
		const selected = new CurrentConversationPanelTranscript({ panels: registry, getSelectedChatId: () => chatId });
		const load = selected.loadMessages(chatId);
		const settled = load.then(() => { cache.markValidated(chatId); return 'loaded'; }, () => 'failed');
		try {
			expect(selected.applyMessages(chatId, viewId, [assistant(81)], 81, 81)).toBe('gap-detected');
			snapshot.resolve(history(entries.slice(0, 80))({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			await started.promise;
			expect(cache.readAppliedCursor(chatId)).toMatchObject({ lastOrdinal: 80, stale: true });
			mount(...peers);
			refresh.resolve(history(entries)({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			if (outcome === 'second-removal') {
				await handoffStarted.promise;
				mount('third');
				handoff.resolve(history(entries)({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			}
			expect(await settled).toBe(succeeds ? 'loaded' : 'failed');
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(remainingPeer ? 3 : 2);
			expect(cache.readAppliedCursor(chatId)).toMatchObject({ lastOrdinal: succeeds ? 81 : 80, stale: !succeeds });
			mount('left');
			if (!succeeds) await registry.loadChatSnapshot(chatId);
			expect(cache.readAppliedCursor(chatId)).toMatchObject({ lastOrdinal: 81, stale: false });
			expect(registry.panel('chat-view:window-left')!.transcript.entries).toEqual(entries);
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(outcome === 'second-removal' ? 4 : 3);
			expect(vi.mocked(getCombinedChatMessages).mock.calls.at(-1)![0]).toEqual({ chatId, direction: 'backward', anchorsRemaining: 100 });
		} finally {
			snapshot.resolve(history(entries.slice(0, 80))({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			refresh.resolve(history(entries)({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			handoff.resolve(history(entries)({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			await settled;
		}
	});

	it('keeps an accepted commit and newer resend candidates during the required refresh', async () => {
		const { cache, overlays, registry, mount } = panelFixture();
		const entries = Array.from({ length: 82 }, (_, index) => input(index + 1));
		const snapshot = Promise.withResolvers<TranscriptAnchorPage>();
		const refresh = Promise.withResolvers<TranscriptAnchorPage>();
		const started = Promise.withResolvers<void>();
		const candidates = (ordinal: number) => [{ ordinal, content: `Synthetic input ${ordinal}`, attachmentNames: [] }];
		const captured = { ...history(entries.slice(0, 81))({ chatId, direction: 'backward', anchorsRemaining: 100 }), resendCandidates: candidates(81) };
		vi.mocked(getCombinedChatMessages)
			.mockImplementationOnce(() => snapshot.promise)
			.mockImplementationOnce(() => { started.resolve(); return refresh.promise; });
		mount('left', 'right');
		const load = registry.loadChatSnapshot(chatId);
		try {
			expect(registry.applyCommittedBatch({ chatId, transcriptViewId: viewId, firstOrdinal: 81, lastOrdinal: 81,
				messages: [input(81)], resendCandidates: candidates(81), noticeRevision: 0,
			})).toMatchObject({ kind: 'chat-recovery-required' });
			snapshot.resolve(captured);
			await started.promise;
			expect(registry.applyCommittedBatch({ chatId, transcriptViewId: viewId, firstOrdinal: 82, lastOrdinal: 82,
				messages: [input(82)], resendCandidates: candidates(82), noticeRevision: 0,
			})).toMatchObject({ kind: 'applied' });
			refresh.resolve(captured);
			await load;
			for (const panel of registry.panelsForChat(chatId)) expect(panel.transcript.entries).toEqual(entries);
			expect(cache.get(chatId)?.messages).toEqual(entries);
			expect(overlays.forChat(chatId).resendCandidates).toEqual(candidates(82));
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(2);
		} finally {
			snapshot.resolve(captured);
			refresh.resolve(captured);
			await load;
		}
	});

	it.each(['failure', 'unavailable', 'replacement', 'removal', 'another-gap'] as const)('fences a required snapshot refresh across %s', async interruption => {
		const { cache, registry, mount } = panelFixture({ retainInactive: true });
		const entries = Array.from({ length: 83 }, (_, index) => assistant(index + 1));
		const snapshot = Promise.withResolvers<TranscriptAnchorPage>();
		const refresh = Promise.withResolvers<Awaited<ReturnType<typeof getCombinedChatMessages>>>();
		const started = Promise.withResolvers<void>();
		installHistory(entries.slice(0, 81));
		vi.mocked(getCombinedChatMessages)
			.mockImplementationOnce(() => snapshot.promise)
			.mockImplementationOnce(() => { started.resolve(); return refresh.promise; });
		mount('left', 'right');
		const load = registry.loadChatSnapshot(chatId);
		const settled = load.then(value => ({ value }), error => ({ error }));
		try {
			expect(registry.applyCommittedBatch({ chatId, transcriptViewId: viewId,
				firstOrdinal: 81, lastOrdinal: 81, messages: [assistant(81)], resendCandidates: [], noticeRevision: 0,
			})).toMatchObject({ kind: 'chat-recovery-required' });
			snapshot.resolve(history(entries.slice(0, 80))({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			await started.promise;
			expect(cache.readAppliedCursor(chatId)).toMatchObject({ lastOrdinal: 80, stale: true });
			if (interruption === 'failure' || interruption === 'unavailable') {
				if (interruption === 'failure') refresh.reject(new Error('Synthetic refresh failure'));
				else refresh.resolve({ chatId, historyState: { kind: 'degraded', errorCode: 'LEDGER_FENCED', retryable: false }, messages: [] });
				expect(await settled).toHaveProperty('error');
				if (interruption === 'failure') expect(cache.readAppliedCursor(chatId)?.stale).toBe(true);
				else expect(cache.readAppliedCursor(chatId)).toBeNull();
				expect(registry.hasInactiveWindow(chatId)).toBe(false);
				await registry.loadChatSnapshot(chatId);
				expect(cache.readAppliedCursor(chatId)).toMatchObject({ lastOrdinal: 81, stale: false });
			} else {
				if (interruption === 'replacement') {
					expect(registry.resetForViewReplacement(chatId, viewId)).toBe(true);
					vi.mocked(getCombinedChatMessages).mockImplementation(async request => ({
						...history([input(1)])(request), transcriptViewId: 'synthetic-new-view',
					}));
					await registry.loadChatSnapshot(chatId);
				} else if (interruption === 'removal') registry.removeChat(chatId);
				else {
					installHistory(entries);
					expect(registry.applyCommittedBatch({ chatId, transcriptViewId: viewId,
						firstOrdinal: 83, lastOrdinal: 83, messages: [assistant(83)], resendCandidates: [], noticeRevision: 0,
					})).toMatchObject({ kind: 'chat-recovery-required' });
				}
				refresh.resolve(history(entries.slice(0, 81))({ chatId, direction: 'backward', anchorsRemaining: 100 }));
				await settled;
				if (interruption === 'replacement') expect(cache.get(chatId)).toMatchObject({ transcriptViewId: 'synthetic-new-view', lastOrdinal: 1, stale: false });
				else if (interruption === 'removal') expect(cache.get(chatId)).toBeNull();
				else for (const panel of registry.panelsForChat(chatId)) expect(panel.transcript.entries).toEqual(entries);
			}
			expect(getCombinedChatMessages).toHaveBeenCalledTimes(interruption === 'removal' ? 2 : 3);
		} finally {
			snapshot.resolve(history(entries.slice(0, 80))({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			refresh.resolve(history(entries.slice(0, 81))({ chatId, direction: 'backward', anchorsRemaining: 100 }));
			await settled;
		}
	});

	it.each([
		{ persisted: false, sameView: false },
		{ persisted: true, sameView: false },
		{ persisted: false, sameView: true },
		{ persisted: true, sameView: true },
	])('preserves a distinct peer after eviction (persisted $persisted, same-view retry $sameView)', async ({ persisted, sameView }) => {
		const { cache, registry, mount } = panelFixture({ maxHiddenEntries: 1 });
		installHistory(Array.from({ length: 101 }, (_, index) => assistant(index + 1)));
		mount('left', 'matching', 'right');
		try {
			await registry.loadChatSnapshot(chatId);
			if (persisted) cache.flush();
			const left = registry.panel('chat-view:window-left')!.transcript;
			const matching = registry.panel('chat-view:window-matching')!.transcript;
			const right = registry.panel('chat-view:window-right')!.transcript;
			const response = Promise.withResolvers<TranscriptAnchorPage>();
			vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
			const load = left.loadEarlierPage(chatId);
			const newerView = 'synthetic-newer-view';
			right.replaceGeneration(chatId, newerView, [assistant(1)], {
				lastOrdinal: 1, pageOldestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false,
			});
			const newerEntries = right.entries;
			const clearPeer = vi.spyOn(right, 'clearMessages');
			// Injects a cache miss independently of visible-panel retention.
			cache.setVisibleChatIds([]);
			cache.replace('synthetic-other-chat', 'synthetic-other-view', [assistant(1)], 1, null);
			expect(cache.get(chatId)).toBeNull();
			const recoveredView = sameView ? viewId : newerView;
			const recovered = Array.from({ length: sameView ? 80 : 1 }, (_, index) => assistant(index + 1));
			let recoveryReads = 0;
			vi.mocked(getCombinedChatMessages).mockImplementation(async request => {
				if (++recoveryReads > 2) throw new Error('Repeated synthetic recovery');
				return history(recovered, 200, recovered.length, recoveredView)(request);
			});
			response.reject(new ApiError(409, 'Synthetic stale view', 'STALE_TRANSCRIPT_VIEW'));
			expect(await load).toBe('invalidated');
			expect(clearPeer).not.toHaveBeenCalled();
			expect(right.entries).toBe(newerEntries);
			expect(left.transcriptViewId).toBe(recoveredView);
			expect(left.entries).toEqual(recovered);
			expect(left.lastOrdinal).toBe(recovered.length);
			expect(left.hasLaterMessages).toBe(false);
			expect(matching.entries).toEqual(recovered);
			expect(matching.lastOrdinal).toBe(recovered.length);
			expect(recoveryReads).toBe(1);
		} finally {
			registry.destroy();
			cache.flush();
		}
	});

	it('prevents reverse-order peer snapshots from regressing the shared receipt cache', async () => {
		const { transcript: first, cache } = fixture();
		const second = new ActiveTranscriptState(cache, null, { combineMessages: true });
		cleanups.push(() => second.clearMessages());
		second.activateChat(chatId);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		installHistory([assistant(100), assistant(101)]);
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const load = first.loadMessages(chatId);
		await second.loadMessages(chatId);
		response.resolve(
			history([assistant(100)])({ chatId, direction: 'backward', anchorsRemaining: 100 }),
		);
		await load;
		expect(first.lastOrdinal).toBe(100);
		expect(cache.readAppliedCursor(chatId)?.lastOrdinal).toBe(101);
		expect(
			cache.applyMessages(chatId, viewId, {
				firstOrdinal: 102,
				lastOrdinal: 102,
				messages: [assistant(102)],
			}).status,
		).toBe('applied');
	});

	it('rejects pre-reset higher-head responses even after the same view is installed again', async () => {
		const { transcript, cache } = fixture();
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const load = transcript.loadMessages(chatId);
		cache.remove(chatId);
		cache.replace(chatId, viewId, [assistant(80)], 80, 80);
		response.resolve(
			history([assistant(100)])({ chatId, direction: 'backward', anchorsRemaining: 100 }),
		);
		await load;
		expect(cache.readAppliedCursor(chatId)?.lastOrdinal).toBe(80);
		expect(transcript.entries).toEqual([]);
	});

	it('keeps newer shared resend commits when an older first snapshot arrives', async () => {
		const overlays = new ConversationTranscriptOverlayStore();
		const publish = vi.spyOn(overlays, 'publishSnapshotResendCandidates');
		const cache = new ChatTranscriptCache({ limit: 100 });
		caches.add(cache);
		const transcript = new ActiveTranscriptState(cache, overlays.forChat(chatId), {
			combineMessages: true,
			onSnapshotResendCandidates: (id, candidates, frontier) => {
				overlays.publishSnapshotResendCandidates(id, candidates, frontier);
			},
		});
		cleanups.push(() => transcript.clearMessages());
		transcript.activateChat(chatId);
		const response = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockImplementationOnce(() => response.promise);
		const load = transcript.loadMessages(chatId);
		overlays.applyCommittedBatch({
			chatId,
			transcriptViewId: viewId,
			lastOrdinal: 2,
			messages: [assistant(2)],
			resendCandidates: [],
			noticeRevision: 0,
		});
		response.resolve({
			...history([input(1)])({ chatId, direction: 'backward', anchorsRemaining: 100 }),
			resendCandidates: [{ ordinal: 1, content: 'Synthetic input', attachmentNames: [] }],
		});
		await load;
		expect(transcript.resendCandidates).toEqual([]);
		expect(publish.mock.calls[0]![2]).toEqual({ transcriptViewId: viewId, lastOrdinal: 1 });
	});
});
