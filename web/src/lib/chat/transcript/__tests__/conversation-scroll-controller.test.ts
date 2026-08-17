import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import {
	ConversationScrollController,
	type ConversationScrollState,
} from '../conversation-scroll-controller.svelte';
import type { ConversationFeedMutationClock } from '../conversation-feed-mutations';
import type { ConversationViewportPort } from '../conversation-viewport-port';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import { AssistantMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import { mountInitialBottomRestoreEffect } from './conversation-scroll-controller-effect-harness.svelte';

const RETIRED_LIVE_EDGE_PRUNE_INTERVAL_MS = 180_000;

function mutationClock(
	dataRevision = 0,
	historyEarlierRevision = 0,
): ConversationFeedMutationClock {
	return {
		dataRevision,
		lastResponseRevisionByMessageType: {},
		lastRevisionByKind: {
			initial: 0,
			'live-append': 0,
			'history-earlier': historyEarlierRevision,
			'history-later': 0,
			replacement: 0,
			'presentation-structure': 0,
		},
	};
}

type MutableConversationScrollState = {
	-readonly [Key in keyof ConversationScrollState]: ConversationScrollState[Key];
};

function scrollState(
	overrides: Partial<ConversationScrollState> = {},
): MutableConversationScrollState {
	return {
		canLoadEarlier: false,
		displayMessageCount: 1,
		feedMutationClock: mutationClock(),
		transcriptViewId: 'generation-1',
		hasLaterMessages: false,
		isLoadingMessages: false,
		isUserScrolledUp: false,
		invalidatePendingHistoryLoad: vi.fn(),
		invalidatePendingWindowNavigation: vi.fn(),
		loadEarlierPage: vi.fn(async () => 'exhausted' as const),
		loadLaterPage: vi.fn(async () => 'exhausted' as const),
		loadStatus: 'loaded',
		navigateToWindow: vi.fn(async () => 'loaded' as const),
		pageStates: {
			earlier: { status: 'idle', error: null },
			later: { status: 'idle', error: null },
		},
		revealEarlierLoadedRows: vi.fn(() => false),
		windowRevision: 0,
		...overrides,
	};
}

function expandedTranscriptState(): ActiveTranscriptState {
	const chat = new ActiveTranscriptState();
	const messages = (firstOrdinal: number, lastOrdinal: number): TranscriptMessage[] =>
		Array.from({ length: lastOrdinal - firstOrdinal + 1 }, (_, index) => {
			const ordinal = firstOrdinal + index;
			return {
				ordinal,
				message: new AssistantMessage('2026-08-16T00:00:00.000Z', `message-${ordinal}`),
			};
		});
	chat.replaceGeneration('chat-1', 'generation-1', messages(1, 200), {
		lastOrdinal: 200,
		pageOldestOrdinal: 1,
		nextBeforeOrdinal: null,
		hasMore: false,
	});
	chat.applyMessages('chat-1', 'generation-1', messages(201, 250), 201, 250);
	chat.visibleMessageCount = 250;
	chat.isUserScrolledUp = true;
	return chat;
}

interface FakeViewport extends ConversationViewportPort {
	isReady: ReturnType<typeof vi.fn<() => boolean>>;
	isAtEnd: ReturnType<typeof vi.fn<(threshold?: number) => boolean>>;
	scrollToStart: ReturnType<typeof vi.fn<() => void>>;
	scrollToEnd: ReturnType<typeof vi.fn<ConversationViewportPort['scrollToEnd']>>;
	restoreInitialEnd: ReturnType<typeof vi.fn<() => void>>;
	scrollBy: ReturnType<typeof vi.fn<(delta: number) => void>>;
	waitForLayout: ReturnType<typeof vi.fn<ConversationViewportPort['waitForLayout']>>;
	measureViewportFill: ReturnType<typeof vi.fn<ConversationViewportPort['measureViewportFill']>>;
	restoreHiddenReadingPosition: ReturnType<
		typeof vi.fn<ConversationViewportPort['restoreHiddenReadingPosition']>
	>;
	cancelPendingLayoutMutation: ReturnType<typeof vi.fn<() => void>>;
	cancelForUserIntent: ReturnType<typeof vi.fn<ConversationViewportPort['cancelForUserIntent']>>;
	scrollToTarget: ReturnType<typeof vi.fn<ConversationViewportPort['scrollToTarget']>>;
}

function fakeViewport(overrides: Partial<ConversationViewportPort> = {}): FakeViewport {
	return {
		isReady: vi.fn(() => true),
		isAtEnd: vi.fn(() => false),
		ownsScrollPosition: vi.fn(() => false),
		scrollToStart: vi.fn(),
		scrollToEnd: vi.fn(),
		restoreInitialEnd: vi.fn(),
		scrollBy: vi.fn(),
		waitForLayout: vi.fn(async () => 'settled'),
		measureViewportFill: vi.fn(async () => 'overflow'),
		restoreHiddenReadingPosition: vi.fn(async () => 'restored'),
		cancelPendingLayoutMutation: vi.fn(),
		cancelForUserIntent: vi.fn(),
		scrollToTarget: vi.fn(async () => 'completed'),
		...overrides,
	} as FakeViewport;
}

class ResizeObserverStub {
	static instances: ResizeObserverStub[] = [];
	observed: Element[] = [];
	disconnected = false;

	constructor(private callback: ResizeObserverCallback) {
		ResizeObserverStub.instances.push(this);
	}

	observe(target: Element): void {
		this.observed.push(target);
	}

	disconnect(): void {
		this.disconnected = true;
	}

	emit(height: number): void {
		const target = this.observed[0];
		if (!target) throw new Error('No observed target');
		this.callback(
			[{ target, contentRect: { height } as DOMRectReadOnly } as ResizeObserverEntry],
			this as unknown as ResizeObserver,
		);
	}
}

function controllerFixture(
	options: {
		state?: Partial<ConversationScrollState>;
		chatState?: ConversationScrollState;
		viewport?: FakeViewport;
		scroller?: Partial<HTMLDivElement>;
		queue?: Partial<HTMLDivElement>;
		chatId?: string | null;
	} = {},
) {
	const viewport = options.viewport ?? fakeViewport();
	const state = (options.chatState ?? scrollState(options.state)) as MutableConversationScrollState;
	const scroller =
		options.scroller instanceof HTMLDivElement
			? options.scroller
			: ({
					scrollTop: 200,
					clientHeight: 400,
					contains: () => false,
					...options.scroller,
				} as HTMLDivElement);
	const queue = options.queue ? ({ ...options.queue } as HTMLDivElement) : undefined;
	const sessions = { selectedChatId: options.chatId === undefined ? 'chat-1' : options.chatId };
	const controller = new ConversationScrollController({
		getScrollContainer: () => scroller,
		getViewport: () => viewport,
		getQueueContainer: () => queue,
		chatState: state,
		sessions,
	});
	return { controller, viewport, state, scroller, sessions };
}

describe('ConversationScrollController', () => {
	const originalResizeObserver = globalThis.ResizeObserver;

	beforeEach(() => {
		ResizeObserverStub.instances = [];
		globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
	});

	afterEach(() => {
		globalThis.ResizeObserver = originalResizeObserver;
		vi.useRealTimers();
	});

	it('delegates physical end checks and end scrolling to the viewport', () => {
		const viewport = fakeViewport({ isAtEnd: vi.fn(() => true) });
		const { controller, state } = controllerFixture({ viewport });

		expect(controller.isNearBottom()).toBe(true);
		expect(viewport.isAtEnd).toHaveBeenCalledWith(50);
		controller.scrollToBottom();

		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
		expect(state.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('cancels pending layout work before recording every user gesture', () => {
		const { controller, viewport } = controllerFixture();
		controller.noteUserScrollIntent('earlier');
		expect(viewport.cancelForUserIntent).toHaveBeenCalledWith('earlier');
	});

	it('requires fresh downward intent to repin inside the later threshold', () => {
		let atEnd = true;
		const viewport = fakeViewport({ isAtEnd: vi.fn(() => atEnd) });
		const { controller, state } = controllerFixture({
			viewport,
			state: { isUserScrolledUp: true },
		});
		controller.setPinnedToBottom(false);
		controller.noteUserScrollIntent('later');
		controller.handleScroll();

		expect(state.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();

		atEnd = false;
		controller.handleScroll();
		expect(state.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('[TLV5-UX.17-WEB-UNIT-01] retains both loaded edges while an earlier page request is active', async () => {
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(1);
		const chatState = expandedTranscriptState();
		chatState.hasEarlierMessages = true;
		const expectedEntries = chatState.entries.map((entry) => [
			entry.ordinal,
			(entry.message as AssistantMessage).content,
		]);
		let resolvePage!: () => void;
		vi.spyOn(chatState, 'loadEarlierPage').mockImplementation(
			() => new Promise<'loaded'>((resolve) => {
				resolvePage = () => resolve('loaded');
			}),
		);
		const fixture = controllerFixture({
			chatState,
			viewport: fakeViewport({ isAtEnd: vi.fn(() => true) }),
		});
		fixture.controller.setPinnedToBottom(false);
		fixture.controller.noteUserScrollIntent('later');
		fixture.controller.handleScroll();

		const pageRequest = fixture.controller.requestPage('earlier', 'button');
		await vi.advanceTimersByTimeAsync(RETIRED_LIVE_EDGE_PRUNE_INTERVAL_MS + 1);

		expect(chatState.entries.map((entry) => [
			entry.ordinal,
			(entry.message as AssistantMessage).content,
		])).toEqual(expectedEntries);
		resolvePage();
		await pageRequest;
		expect(chatState.entries.map((entry) => entry.ordinal)).toEqual(
			expectedEntries.map(([ordinal]) => ordinal),
		);
	});

	it('[TLV5-UX.17-WEB-UNIT-02] retains both loaded edges while the viewport owns a programmatic scroll', async () => {
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(1);
		const chatState = expandedTranscriptState();
		const expectedOrdinals = chatState.entries.map((entry) => entry.ordinal);
		let ownsScrollPosition = false;
		const fixture = controllerFixture({
			chatState,
			viewport: fakeViewport({
				isAtEnd: vi.fn(() => true),
				ownsScrollPosition: vi.fn(() => ownsScrollPosition),
			}),
		});
		fixture.controller.setPinnedToBottom(false);
		fixture.controller.noteUserScrollIntent('later');
		fixture.controller.handleScroll();
		ownsScrollPosition = true;

		await vi.advanceTimersByTimeAsync(RETIRED_LIVE_EDGE_PRUNE_INTERVAL_MS + 1);

		expect(chatState.entries.map((entry) => entry.ordinal)).toEqual(expectedOrdinals);
	});

	it('[TLV5-UX.17-WEB-UNIT-03] retains a bottom-pinned expanded interval beyond the retired prune delay', async () => {
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(1);
		const chatState = expandedTranscriptState();
		const expectedEntries = chatState.entries.map((entry) => [
			entry.ordinal,
			(entry.message as AssistantMessage).content,
		]);
		const fixture = controllerFixture({
			chatState,
			viewport: fakeViewport({ isAtEnd: vi.fn(() => true) }),
		});
		fixture.controller.setPinnedToBottom(false);
		fixture.controller.noteUserScrollIntent('later');
		fixture.controller.handleScroll();

		await vi.advanceTimersByTimeAsync(RETIRED_LIVE_EDGE_PRUNE_INTERVAL_MS + 1);

		expect(chatState.entries.map((entry) => [
			entry.ordinal,
			(entry.message as AssistantMessage).content,
		])).toEqual(expectedEntries);
	});

	it('does not repin from proximity without user intent', () => {
		const viewport = fakeViewport({ isAtEnd: vi.fn(() => true) });
		const { controller, state } = controllerFixture({
			viewport,
			state: { isUserScrolledUp: true },
		});
		controller.setPinnedToBottom(false);
		controller.handleScroll();
		expect(state.isUserScrolledUp).toBe(true);
		expect(viewport.scrollToEnd).not.toHaveBeenCalled();
	});

	it('prefetches earlier history two viewports before the top edge', async () => {
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const { controller } = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 750 },
		});

		controller.noteUserScrollIntent('earlier');
		controller.handleScroll();

		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledOnce());
	});

	it('prefetches from an upward gesture when the top edge cannot emit another scroll event', async () => {
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const { controller } = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 0 },
		});

		controller.noteUserScrollIntent('earlier');

		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledOnce());
	});

	it('does not prefetch earlier history outside the viewport-ahead zone', () => {
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const { controller } = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 801 },
		});

		controller.noteUserScrollIntent('earlier');
		controller.handleScroll();

		expect(loadEarlierPage).not.toHaveBeenCalled();
	});

	it('infers earlier intent from a pointer-originated scrollbar movement', async () => {
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const fixture = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 900 },
		});

		fixture.controller.noteUserScrollIntent();
		fixture.scroller.scrollTop = 750;
		fixture.controller.handleScroll();

		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledOnce());
		expect(fixture.viewport.cancelForUserIntent).toHaveBeenNthCalledWith(1, null);
		expect(fixture.viewport.cancelForUserIntent).toHaveBeenNthCalledWith(2, 'earlier');
	});

	it('keeps earlier prefetch armed across a slow pointer-originated scroll', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(100);
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const fixture = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 900 },
		});

		fixture.controller.noteUserScrollIntent();
		fixture.scroller.scrollTop = 850;
		fixture.controller.handleScroll();
		now.mockReturnValue(1_500);
		fixture.scroller.scrollTop = 820;
		fixture.controller.handleScroll();
		now.mockReturnValue(2_200);
		fixture.scroller.scrollTop = 750;
		fixture.controller.handleScroll();

		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledOnce());
		now.mockRestore();
	});

	it('does not page after stale earlier intent enters the zone without input', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(100);
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const fixture = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 2_000 },
		});

		fixture.controller.noteUserScrollIntent('earlier');
		await Promise.resolve();
		fixture.scroller.scrollTop = 1_900;
		fixture.controller.handleScroll();
		now.mockReturnValue(1_000_000);
		fixture.scroller.scrollTop = 700;
		fixture.controller.handleScroll();
		await Promise.resolve();

		expect(loadEarlierPage).not.toHaveBeenCalled();
		now.mockRestore();
	});

	it('[TLV5-UX.07-WEB-UNIT-02] does not page from a viewport-owned scroll inside the intent window', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(100);
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const fixture = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 2_000 },
			viewport: fakeViewport({ ownsScrollPosition: vi.fn(() => true) }),
		});

		fixture.controller.noteUserScrollIntent('earlier');
		await Promise.resolve();
		fixture.scroller.scrollTop = 700;
		fixture.controller.handleScroll();
		await Promise.resolve();

		expect(loadEarlierPage).not.toHaveBeenCalled();
		now.mockRestore();
	});

	it('pages after viewport scroll ownership releases inside the intent window', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(100);
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const ownsScrollPosition = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
		const fixture = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 900 },
			viewport: fakeViewport({ ownsScrollPosition }),
		});

		fixture.controller.noteUserScrollIntent('earlier');
		await Promise.resolve();
		fixture.scroller.scrollTop = 775;
		fixture.controller.handleScroll();
		expect(loadEarlierPage).not.toHaveBeenCalled();
		fixture.scroller.scrollTop = 750;
		fixture.controller.handleScroll();

		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledOnce());
		expect(ownsScrollPosition).toHaveBeenCalledTimes(2);
		now.mockRestore();
	});

	it('prefetches later history without widening the live-end repin zone', async () => {
		const loadLaterPage = vi.fn(async () => 'exhausted' as const);
		const viewport = fakeViewport({
			isAtEnd: vi.fn((threshold = 0) => threshold >= 400),
		});
		const { controller, state } = controllerFixture({
			viewport,
			state: {
				hasLaterMessages: true,
				isUserScrolledUp: true,
				loadLaterPage,
			},
			scroller: { clientHeight: 400, scrollTop: 1_000 },
		});
		controller.setPinnedToBottom(false);

		controller.noteUserScrollIntent('later');
		controller.handleScroll();

		await vi.waitFor(() => expect(loadLaterPage).toHaveBeenCalledOnce());
		expect(viewport.isAtEnd).toHaveBeenCalledWith(50);
		expect(viewport.isAtEnd).toHaveBeenCalledWith(400);
		expect(viewport.scrollToEnd).not.toHaveBeenCalled();
		expect(controller.isPinnedToBottom).toBe(false);
		expect(state.isUserScrolledUp).toBe(true);
	});

	it('[TLV5-UX.07-WEB-UNIT-01] requires fresh directional intent for viewport-ahead prefetching', () => {
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const { controller } = controllerFixture({
			state: { canLoadEarlier: true, isUserScrolledUp: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 350 },
		});
		controller.setPinnedToBottom(false);

		controller.handleScroll();

		expect(loadEarlierPage).not.toHaveBeenCalled();
	});

	it('does not carry earlier intent across a paging-context reset', async () => {
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const fixture = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 900 },
		});

		fixture.controller.noteUserScrollIntent('earlier');
		await Promise.resolve();
		fixture.sessions.selectedChatId = 'chat-2';
		fixture.controller.prepareInitialBottomRestore('chat-2');
		fixture.scroller.scrollTop = 750;
		fixture.controller.handleScroll();
		await Promise.resolve();

		expect(loadEarlierPage).not.toHaveBeenCalled();
	});

	it('requires fresh earlier intent after leaving and re-entering the load-ahead zone', async () => {
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const fixture = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 900 },
		});

		fixture.controller.noteUserScrollIntent('earlier');
		await Promise.resolve();
		fixture.scroller.scrollTop = 750;
		await expect(fixture.controller.requestPage('earlier', 'scroll')).resolves.toBe('exhausted');
		expect(loadEarlierPage).toHaveBeenCalledOnce();

		fixture.scroller.scrollTop = 900;
		fixture.controller.handleScroll();
		fixture.scroller.scrollTop = 750;
		fixture.controller.handleScroll();
		await Promise.resolve();

		expect(loadEarlierPage).toHaveBeenCalledOnce();
	});

	it('rearms an advanced earlier cursor after its geometry settle is superseded', async () => {
		const loadEarlierPage = vi.fn<ConversationScrollState['loadEarlierPage']>();
		const fixture = controllerFixture({
			viewport: fakeViewport({
				waitForLayout: vi.fn<ConversationViewportPort['waitForLayout']>(async () => 'superseded'),
			}),
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 750 },
		});
		loadEarlierPage
			.mockImplementationOnce(async () => {
				fixture.state.feedMutationClock = mutationClock(1, 1);
				return 'loaded';
			})
			.mockResolvedValueOnce('exhausted');

		fixture.controller.noteUserScrollIntent('earlier');
		fixture.controller.handleScroll();
		await vi.waitFor(() => expect(fixture.viewport.waitForLayout).toHaveBeenCalledOnce());
		await Promise.resolve();

		fixture.controller.noteUserScrollIntent('earlier');
		fixture.controller.handleScroll();

		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledTimes(2));
	});

	it('rearms the same earlier cursor after an invalidated prefetch', async () => {
		const loadEarlierPage = vi
			.fn<ConversationScrollState['loadEarlierPage']>()
			.mockResolvedValueOnce('invalidated')
			.mockResolvedValueOnce('exhausted');
		const fixture = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 750 },
		});

		fixture.controller.noteUserScrollIntent('earlier');
		await expect(fixture.controller.requestPage('earlier', 'scroll')).resolves.toBe('invalidated');

		fixture.controller.noteUserScrollIntent('earlier');
		fixture.controller.handleScroll();

		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledTimes(2));
	});

	it('preserves continued earlier intent while a prefetch settles', async () => {
		let resolveFirstPage!: (result: 'loaded') => void;
		const firstPage = new Promise<'loaded'>((resolve) => (resolveFirstPage = resolve));
		const loadEarlierPage = vi
			.fn<ConversationScrollState['loadEarlierPage']>()
			.mockImplementationOnce(() => firstPage)
			.mockResolvedValueOnce('exhausted');
		const fixture = controllerFixture({
			viewport: fakeViewport({
				waitForLayout: vi.fn<ConversationViewportPort['waitForLayout']>(async () => 'superseded'),
			}),
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 350 },
		});

		fixture.controller.noteUserScrollIntent('earlier');
		fixture.controller.handleScroll();
		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledOnce());

		fixture.controller.noteUserScrollIntent('earlier');
		fixture.controller.handleScroll();
		fixture.state.feedMutationClock = mutationClock(1, 1);
		resolveFirstPage('loaded');

		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledTimes(2));
	});

	it('reaffirms matching user ownership after an active earlier page publishes geometry', async () => {
		let resolveLayout!: (result: 'settled') => void;
		const waitForLayout = vi.fn<ConversationViewportPort['waitForLayout']>(
			() => new Promise<'settled'>((resolve) => (resolveLayout = resolve)),
		);
		const loadEarlierPage = vi.fn(async () => 'loaded' as const);
		const invalidatePendingWindowNavigation = vi.fn();
		const fixture = controllerFixture({
			viewport: fakeViewport({ waitForLayout }),
			state: {
				canLoadEarlier: true,
				invalidatePendingWindowNavigation,
				loadEarlierPage,
			},
			scroller: { clientHeight: 400, scrollTop: 590 },
		});

		fixture.controller.noteUserScrollIntent('earlier');
		const request = fixture.controller.requestPage('earlier', 'scroll');
		await vi.waitFor(() => expect(waitForLayout).toHaveBeenCalledOnce());
		expect(fixture.viewport.cancelForUserIntent).toHaveBeenCalledOnce();
		fixture.viewport.cancelForUserIntent.mockClear();
		const invalidationCount = invalidatePendingWindowNavigation.mock.calls.length;

		fixture.scroller.scrollTop = 8_490;
		fixture.controller.handleScroll();
		expect(fixture.viewport.cancelForUserIntent).not.toHaveBeenCalled();

		fixture.scroller.scrollTop = 8_484;
		fixture.controller.handleScroll();
		expect(fixture.viewport.cancelForUserIntent).toHaveBeenCalledOnce();
		expect(fixture.viewport.cancelForUserIntent).toHaveBeenCalledWith('earlier');
		expect(invalidatePendingWindowNavigation).toHaveBeenCalledTimes(invalidationCount);
		expect(loadEarlierPage).toHaveBeenCalledOnce();

		resolveLayout('settled');
		await expect(request).resolves.toBe('loaded');
		expect(loadEarlierPage).toHaveBeenCalledOnce();
	});

	it('does not chain an earlier page after its initiating intent expires', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(100);
		let resolveFirstPage!: (result: 'loaded') => void;
		const firstPage = new Promise<'loaded'>((resolve) => (resolveFirstPage = resolve));
		const loadEarlierPage = vi
			.fn<ConversationScrollState['loadEarlierPage']>()
			.mockImplementationOnce(() => firstPage)
			.mockResolvedValueOnce('exhausted');
		const fixture = controllerFixture({
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 400, scrollTop: 350 },
		});

		fixture.controller.noteUserScrollIntent('earlier');
		fixture.controller.handleScroll();
		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledOnce());

		now.mockReturnValue(2_200);
		fixture.state.feedMutationClock = mutationClock(1, 1);
		resolveFirstPage('loaded');

		await vi.waitFor(() => expect(fixture.viewport.waitForLayout).toHaveBeenCalledOnce());
		expect(loadEarlierPage).toHaveBeenCalledOnce();
		now.mockRestore();
	});

	it('detaches on fresh upward intent inside the later threshold', () => {
		const viewport = fakeViewport({ isAtEnd: vi.fn(() => true) });
		const { controller, state } = controllerFixture({ viewport });

		controller.noteUserScrollIntent('earlier');
		controller.handleScroll();

		expect(state.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
		expect(viewport.scrollToEnd).not.toHaveBeenCalled();
	});

	it('keeps older windows detached even at their physical end', () => {
		const viewport = fakeViewport({ isAtEnd: vi.fn(() => true) });
		const { controller, state } = controllerFixture({
			viewport,
			state: { hasLaterMessages: true },
		});
		controller.noteUserScrollIntent('later');
		controller.handleScroll();
		expect(state.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('waits for the exact data revision after an earlier page mutation', async () => {
		const viewport = fakeViewport();
		const clock = mutationClock(4);
		const loadEarlierPage = vi.fn(async () => {
			clock.dataRevision = 5;
			return 'loaded' as const;
		});
		const { controller, state } = controllerFixture({
			viewport,
			state: { canLoadEarlier: true, feedMutationClock: clock, loadEarlierPage },
		});

		expect(await controller.requestPage('earlier', 'button')).toBe('loaded');
		expect(viewport.waitForLayout).toHaveBeenCalledWith({ minimumDataRevision: 5 });
		expect(state.isUserScrolledUp).toBe(true);
	});

	it('[TLV5-UX.07-WEB-UNIT-03] requires an explicit retry after a directional page failure', async () => {
		const loadEarlierPage = vi.fn(async () => 'loaded' as const);
		const { controller, scroller } = controllerFixture({
			state: {
				canLoadEarlier: true,
				loadEarlierPage,
				pageStates: {
					earlier: { status: 'error', error: 'network unavailable' },
					later: { status: 'idle', error: null },
				},
			},
			scroller: { scrollTop: 0 },
		});

		controller.noteUserScrollIntent('earlier');
		controller.handleScroll();
		expect(loadEarlierPage).not.toHaveBeenCalled();

		await expect(controller.requestPage('earlier', 'button')).resolves.toBe('loaded');
		expect(loadEarlierPage).toHaveBeenCalledOnce();
		expect(scroller.scrollTop).toBe(0);
	});

	it('invalidates a page mutation when layout is superseded', async () => {
		const waitForLayout = vi
			.fn<ConversationViewportPort['waitForLayout']>()
			.mockResolvedValue('superseded');
		const viewport = fakeViewport({ waitForLayout });
		const { controller } = controllerFixture({
			viewport,
			state: { hasLaterMessages: true, loadLaterPage: vi.fn(async () => 'loaded' as const) },
		});
		expect(await controller.requestPage('later', 'button')).toBe('invalidated');
	});

	it('invalidates a page mutation when the selected chat changes', async () => {
		let resolve!: () => void;
		const pending = new Promise<void>((done) => (resolve = done));
		const { controller, sessions } = controllerFixture({
			state: {
				canLoadEarlier: true,
				loadEarlierPage: vi.fn(async () => {
					await pending;
					return 'loaded' as const;
				}),
			},
		});
		const request = controller.requestPage('earlier', 'button');
		sessions.selectedChatId = 'chat-2';
		resolve();
		expect(await request).toBe('invalidated');
	});

	it('lets the virtualizer preserve a detached navigator page', async () => {
		const { controller, viewport, state } = controllerFixture({
			state: {
				isUserScrolledUp: true,
				loadEarlierPage: vi.fn(async () => 'loaded' as const),
			},
		});
		controller.setPinnedToBottom(false);
		expect(await controller.loadEarlierPageForNavigator('chat-1')).toBe('loaded');
		expect(viewport.scrollToEnd).not.toHaveBeenCalled();
		expect(state.isUserScrolledUp).toBe(true);
	});

	it('restores a pinned navigator page to the end', async () => {
		const { controller, viewport } = controllerFixture({
			state: { loadEarlierPage: vi.fn(async () => 'loaded' as const) },
		});
		controller.setPinnedToBottom(true);
		expect(await controller.loadEarlierPageForNavigator('chat-1')).toBe('loaded');
		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
	});

	it('routes message and DOM-anchor navigation through the virtual target index', async () => {
		const observed: { controller: ConversationScrollController | null } = { controller: null };
		const viewport = fakeViewport({
			isAtEnd: vi.fn(() => false),
			scrollToTarget: vi.fn<ConversationViewportPort['scrollToTarget']>(async () => {
				expect(observed.controller?.isPinnedToBottom).toBe(false);
				return 'completed';
			}),
		});
		const fixture = controllerFixture({ viewport });
		const { controller } = fixture;
		observed.controller = controller;
		const { state } = fixture;
		expect(
			await controller.jumpToMessageRow({
				chatId: 'chat-1',
				transcriptViewId: 'generation-1',
				rowId: 'generation-1:7',
			}),
		).toBe('completed');
		expect(viewport.scrollToTarget).toHaveBeenNthCalledWith(
			1,
			{ kind: 'row', id: 'generation-1:7' },
			{ align: 'center' },
		);
		expect(await controller.jumpToDomAnchor('tool-input-9')).toBe(true);
		expect(viewport.scrollToTarget).toHaveBeenNthCalledWith(
			2,
			{ kind: 'dom-anchor', id: 'tool-input-9' },
			{ align: 'center' },
		);
		expect(state.isUserScrolledUp).toBe(true);
	});

	it('rejects a message target from another generation without scrolling', async () => {
		const { controller, viewport } = controllerFixture();
		expect(
			await controller.jumpToMessageRow({
				chatId: 'chat-1',
				transcriptViewId: 'generation-2',
				rowId: 'generation-2:1',
			}),
		).toBe('unavailable');
		expect(viewport.scrollToTarget).not.toHaveBeenCalled();
	});

	it('reports user-cancelled target navigation without treating it as missing', async () => {
		const viewport = fakeViewport({
			scrollToTarget: vi.fn<ConversationViewportPort['scrollToTarget']>(async () => 'cancelled'),
		});
		const { controller } = controllerFixture({ viewport });

		await expect(
			controller.jumpToMessageRow({
				chatId: 'chat-1',
				transcriptViewId: 'generation-1',
				rowId: 'generation-1:7',
			}),
		).resolves.toBe('cancelled');
	});

	it('restores live following when pinned target navigation becomes unavailable', async () => {
		const viewport = fakeViewport({
			isAtEnd: vi.fn(() => false),
			scrollToTarget: vi.fn<ConversationViewportPort['scrollToTarget']>(
				async () => 'target-missing',
			),
		});
		const { controller, state } = controllerFixture({ viewport });

		await expect(
			controller.jumpToMessageRow({
				chatId: 'chat-1',
				transcriptViewId: 'generation-1',
				rowId: 'generation-1:7',
			}),
		).resolves.toBe('unavailable');
		expect(controller.isPinnedToBottom).toBe(true);
		expect(state.isUserScrolledUp).toBe(false);
		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
	});

	it('reveals earlier rows until measured content overflows', async () => {
		const measureViewportFill = vi
			.fn<ConversationViewportPort['measureViewportFill']>()
			.mockResolvedValueOnce('underfilled')
			.mockResolvedValueOnce('overflow');
		const revealEarlierLoadedRows = vi.fn(() => true);
		const viewport = fakeViewport({ measureViewportFill });
		const { controller } = controllerFixture({
			viewport,
			state: { canLoadEarlier: true, revealEarlierLoadedRows },
		});
		await controller.fillUnderfilledViewport();
		expect(revealEarlierLoadedRows).toHaveBeenCalledOnce();
		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
	});

	it('loads later history to fill an underfilled older window', async () => {
		const measureViewportFill = vi
			.fn<ConversationViewportPort['measureViewportFill']>()
			.mockResolvedValueOnce('underfilled')
			.mockResolvedValueOnce('overflow');
		const state = { hasLaterMessages: true };
		const loadLaterPage = vi.fn(async () => {
			state.hasLaterMessages = false;
			return 'loaded' as const;
		});
		const { controller } = controllerFixture({
			viewport: fakeViewport({ measureViewportFill }),
			state: { ...state, loadLaterPage },
		});
		await controller.fillUnderfilledViewport();
		expect(loadLaterPage).toHaveBeenCalledWith('chat-1');
	});

	it('stops autofill when measured geometry cannot settle', async () => {
		const measureViewportFill = vi
			.fn<ConversationViewportPort['measureViewportFill']>()
			.mockResolvedValue('unsettled');
		const viewport = fakeViewport({ measureViewportFill });
		const loadEarlierPage = vi.fn(async () => 'loaded' as const);
		const { controller } = controllerFixture({
			viewport,
			state: { canLoadEarlier: true, loadEarlierPage },
		});
		await controller.fillUnderfilledViewport();
		expect(loadEarlierPage).not.toHaveBeenCalled();
	});

	it('does not automatically retry a failed page while filling the viewport', async () => {
		const loadEarlierPage = vi.fn(async () => 'loaded' as const);
		const { controller } = controllerFixture({
			viewport: fakeViewport({
				measureViewportFill: vi.fn<ConversationViewportPort['measureViewportFill']>(
					async () => 'underfilled',
				),
			}),
			state: {
				canLoadEarlier: true,
				loadEarlierPage,
				pageStates: {
					earlier: { status: 'error', error: 'network unavailable' },
					later: { status: 'idle', error: null },
				},
			},
		});

		await controller.fillUnderfilledViewport();
		expect(loadEarlierPage).not.toHaveBeenCalled();
	});

	it('does not reveal loaded rows to bypass an earlier-page error latch', async () => {
		const revealEarlierLoadedRows = vi.fn(() => true);
		const loadEarlierPage = vi.fn(async () => 'loaded' as const);
		const { controller } = controllerFixture({
			viewport: fakeViewport({
				measureViewportFill: vi.fn<ConversationViewportPort['measureViewportFill']>(
					async () => 'underfilled',
				),
			}),
			state: {
				canLoadEarlier: true,
				loadEarlierPage,
				pageStates: {
					earlier: { status: 'error', error: 'network unavailable' },
					later: { status: 'idle', error: null },
				},
				revealEarlierLoadedRows,
			},
		});

		await controller.fillUnderfilledViewport();
		expect(revealEarlierLoadedRows).not.toHaveBeenCalled();
		expect(loadEarlierPage).not.toHaveBeenCalled();
	});

	it('does not let viewport autofill cancel an explicit target navigation', async () => {
		let resolveFill!: (result: 'underfilled') => void;
		let resolveTarget!: (result: 'completed') => void;
		const measureViewportFill = vi
			.fn<ConversationViewportPort['measureViewportFill']>()
			.mockImplementationOnce(
				() => new Promise<'underfilled'>((resolve) => (resolveFill = resolve)),
			)
			.mockResolvedValueOnce('underfilled')
			.mockResolvedValueOnce('overflow');
		const scrollToTarget = vi.fn<ConversationViewportPort['scrollToTarget']>(
			() => new Promise<'completed'>((resolve) => (resolveTarget = resolve)),
		);
		const loadEarlierPage = vi.fn(async () => 'loaded' as const);
		const viewport = fakeViewport({
			isAtEnd: vi.fn(() => true),
			measureViewportFill,
			scrollToTarget,
		});
		const { controller } = controllerFixture({
			viewport,
			state: { canLoadEarlier: true, loadEarlierPage },
		});

		const fill = controller.fillUnderfilledViewport();
		await vi.waitFor(() => expect(measureViewportFill).toHaveBeenCalledOnce());
		const navigation = controller.jumpToMessageRow({
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			rowId: 'generation-1:7',
		});
		await vi.waitFor(() => expect(scrollToTarget).toHaveBeenCalledOnce());

		resolveFill('underfilled');
		await fill;
		expect(loadEarlierPage).not.toHaveBeenCalled();
		resolveTarget('completed');
		await expect(navigation).resolves.toBe('completed');
		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledOnce());
	});

	it('does not let viewport autofill cancel a DOM-anchor navigation', async () => {
		let resolveTarget!: (result: 'completed') => void;
		const scrollToTarget = vi.fn<ConversationViewportPort['scrollToTarget']>(
			() => new Promise<'completed'>((resolve) => (resolveTarget = resolve)),
		);
		const measureViewportFill = vi
			.fn<ConversationViewportPort['measureViewportFill']>()
			.mockResolvedValueOnce('underfilled')
			.mockResolvedValueOnce('overflow');
		const loadEarlierPage = vi.fn(async () => 'loaded' as const);
		const { controller } = controllerFixture({
			viewport: fakeViewport({ isAtEnd: vi.fn(() => true), measureViewportFill, scrollToTarget }),
			state: { canLoadEarlier: true, loadEarlierPage },
		});

		const navigation = controller.jumpToDomAnchor('tool-input-9');
		await vi.waitFor(() => expect(scrollToTarget).toHaveBeenCalledOnce());
		await controller.fillUnderfilledViewport();

		expect(measureViewportFill).not.toHaveBeenCalled();
		expect(loadEarlierPage).not.toHaveBeenCalled();
		resolveTarget('completed');
		await expect(navigation).resolves.toBe(true);
		await vi.waitFor(() => expect(loadEarlierPage).toHaveBeenCalledOnce());
	});

	it('detaches a completed DOM-anchor jump away from the live end', async () => {
		const loadEarlierPage = vi.fn(async () => 'loaded' as const);
		const viewport = fakeViewport({
			isAtEnd: vi.fn(() => false),
			measureViewportFill: vi.fn<ConversationViewportPort['measureViewportFill']>(
				async () => 'underfilled',
			),
		});
		const { controller, state } = controllerFixture({
			viewport,
			state: { canLoadEarlier: true, loadEarlierPage },
		});

		await expect(controller.jumpToDomAnchor('tool-input-9')).resolves.toBe(true);
		await tick();

		expect(controller.isPinnedToBottom).toBe(false);
		expect(state.isUserScrolledUp).toBe(true);
		expect(viewport.measureViewportFill).not.toHaveBeenCalled();
		expect(loadEarlierPage).not.toHaveBeenCalled();
	});

	it('reconciles queue height through the viewport without row geometry', () => {
		const queue = { offsetHeight: 100 };
		const { controller, viewport } = controllerFixture({ queue });
		controller.setPinnedToBottom(false);
		const cleanup = controller.observeQueueResize();
		ResizeObserverStub.instances[0].emit(140);
		expect(viewport.scrollBy).toHaveBeenCalledWith(40);
		controller.setPinnedToBottom(true);
		ResizeObserverStub.instances[0].emit(160);
		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
		cleanup?.();
		expect(ResizeObserverStub.instances[0].disconnected).toBe(true);
	});

	it('defers automatic queue compensation during target navigation', async () => {
		let resolveTarget!: (result: 'completed') => void;
		const viewport = fakeViewport({
			scrollToTarget: vi.fn<ConversationViewportPort['scrollToTarget']>(
				() => new Promise<'completed'>((resolve) => (resolveTarget = resolve)),
			),
		});
		const { controller } = controllerFixture({ viewport, queue: { offsetHeight: 100 } });
		controller.setPinnedToBottom(false);
		controller.observeQueueResize();
		const navigation = controller.jumpToDomAnchor('tool-input-9');
		await vi.waitFor(() => expect(viewport.scrollToTarget).toHaveBeenCalledOnce());

		ResizeObserverStub.instances[0].emit(140);
		expect(viewport.scrollBy).not.toHaveBeenCalled();
		expect(viewport.scrollToEnd).not.toHaveBeenCalled();

		resolveTarget('completed');
		await navigation;
		ResizeObserverStub.instances[0].emit(160);
		expect(viewport.scrollBy).toHaveBeenCalledWith(20);
	});

	it('restores only pinned viewports after a viewport resize', () => {
		const { controller, viewport } = controllerFixture({ scroller: { clientHeight: 400 } });
		controller.setPinnedToBottom(false);
		controller.observeScrollContainerResize();
		ResizeObserverStub.instances[0].emit(360);
		expect(viewport.scrollToEnd).not.toHaveBeenCalled();
		controller.setPinnedToBottom(true);
		ResizeObserverStub.instances[0].emit(320);
		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
	});

	it('restores a pinned hidden viewport through the port', async () => {
		const { controller, viewport } = controllerFixture();
		// The fake reaches the physical end only after the corrective recheck scroll, so
		// the bounded recheck issues exactly one extra end scroll and then stops.
		viewport.isAtEnd.mockImplementation(() => viewport.scrollToEnd.mock.calls.length >= 2);
		controller.setViewportVisible(false);
		controller.setViewportVisible(true);
		await vi.waitFor(() => expect(viewport.scrollToEnd).toHaveBeenCalledTimes(2));
		await tick();
		expect(viewport.scrollToEnd).toHaveBeenCalledTimes(2);
		expect(viewport.restoreHiddenReadingPosition).not.toHaveBeenCalled();
	});

	it('skips the pinned show recheck when the viewport already rests at the end', async () => {
		const { controller, viewport } = controllerFixture();
		viewport.isAtEnd.mockReturnValue(true);
		controller.setViewportVisible(false);
		controller.setViewportVisible(true);
		await vi.waitFor(() => expect(viewport.scrollToEnd).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(viewport.waitForLayout).toHaveBeenCalled());
		await tick();
		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
	});

	it('restores a detached hidden viewport by stable virtual key', async () => {
		const { controller, viewport } = controllerFixture({ state: { isUserScrolledUp: true } });
		controller.setPinnedToBottom(false);
		controller.setViewportVisible(false);
		controller.setViewportVisible(true);
		await vi.waitFor(() => expect(viewport.restoreHiddenReadingPosition).toHaveBeenCalledOnce());
		expect(viewport.scrollToEnd).not.toHaveBeenCalled();
	});

	it('rebaselines inferred gesture direction across viewport visibility changes', () => {
		vi.spyOn(performance, 'now').mockReturnValue(100);
		const fixture = controllerFixture({ scroller: { scrollTop: 900 } });
		fixture.controller.noteUserScrollIntent();
		expect(fixture.viewport.cancelForUserIntent).toHaveBeenCalledOnce();

		fixture.controller.setViewportVisible(false);
		fixture.scroller.scrollTop = 100;
		fixture.controller.handleScroll();
		fixture.controller.setViewportVisible(true);
		fixture.controller.handleScroll();

		expect(fixture.viewport.cancelForUserIntent).toHaveBeenCalledTimes(1);
		expect(fixture.viewport.cancelForUserIntent).toHaveBeenCalledWith(null);
	});

	it('does not page from an owned hidden-offset clamp after a directionless press', async () => {
		vi.spyOn(performance, 'now').mockReturnValue(100);
		const loadEarlierPage = vi.fn(async () => 'exhausted' as const);
		const viewport = fakeViewport({ ownsScrollPosition: vi.fn(() => true) });
		const fixture = controllerFixture({
			viewport,
			state: { canLoadEarlier: true, loadEarlierPage },
			scroller: { clientHeight: 700, scrollTop: 5_000 },
		});
		fixture.controller.noteUserScrollIntent();
		fixture.controller.setViewportVisible(false);
		fixture.scroller.scrollTop = 1_200;
		fixture.controller.setViewportVisible(true);

		fixture.controller.handleScroll();
		await Promise.resolve();

		expect(loadEarlierPage).not.toHaveBeenCalled();
		expect(viewport.cancelForUserIntent.mock.calls).toEqual([[null]]);
	});

	it('cancels a queued hidden-position restore when explicit navigation starts', async () => {
		const { controller, viewport } = controllerFixture({ state: { isUserScrolledUp: true } });
		controller.setPinnedToBottom(false);
		controller.setViewportVisible(false);
		controller.setViewportVisible(true);

		await expect(
			controller.jumpToMessageRow({
				chatId: 'chat-1',
				transcriptViewId: 'generation-1',
				rowId: 'generation-1:7',
			}),
		).resolves.toBe('completed');
		await tick();

		expect(viewport.scrollToTarget).toHaveBeenCalledOnce();
		expect(viewport.restoreHiddenReadingPosition).not.toHaveBeenCalled();
	});

	it('cancels a hidden-position restore scheduled during explicit navigation', async () => {
		const { controller, viewport } = controllerFixture({ state: { isUserScrolledUp: true } });
		controller.setPinnedToBottom(false);
		controller.setViewportVisible(false);
		const navigation = controller.jumpToMessageRow({
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			rowId: 'generation-1:7',
		});
		controller.setViewportVisible(true);

		await expect(navigation).resolves.toBe('completed');
		await tick();

		expect(viewport.scrollToTarget).toHaveBeenCalledOnce();
		expect(viewport.restoreHiddenReadingPosition).not.toHaveBeenCalled();
	});

	it('tracks and completes initial end restoration', () => {
		const { controller, viewport } = controllerFixture();
		controller.prepareInitialBottomRestore('chat-1');
		expect(viewport.cancelPendingLayoutMutation).toHaveBeenCalledOnce();
		expect(controller.isPreparingInitialScroll).toBe(true);
		controller.completeInitialBottomRestore();
		expect(controller.isPreparingInitialScroll).toBe(false);
	});

	it('retries initial-end reconciliation after viewport autofill finishes', async () => {
		let resolveLayout!: (result: 'settled') => void;
		const viewport = fakeViewport({
			waitForLayout: vi.fn<ConversationViewportPort['waitForLayout']>(
				() => new Promise<'settled'>((resolve) => (resolveLayout = resolve)),
			),
			measureViewportFill: vi.fn<ConversationViewportPort['measureViewportFill']>(
				async () => 'overflow',
			),
		});
		const { controller } = controllerFixture({ viewport });
		controller.prepareInitialBottomRestore('chat-1');
		const fill = controller.fillUnderfilledViewport();
		await vi.waitFor(() => expect(viewport.waitForLayout).toHaveBeenCalledOnce());
		const dispose = mountInitialBottomRestoreEffect(controller);
		try {
			await tick();
			expect(viewport.restoreInitialEnd).not.toHaveBeenCalled();

			resolveLayout('settled');
			await fill;
			await tick();
			expect(viewport.restoreInitialEnd).toHaveBeenCalledOnce();
		} finally {
			dispose();
		}
	});

	it('retries initial-end reconciliation after target navigation finishes', async () => {
		let resolveTarget!: (result: 'completed') => void;
		const viewport = fakeViewport({
			isAtEnd: vi.fn(() => false),
			scrollToTarget: vi.fn(() => new Promise<'completed'>((resolve) => (resolveTarget = resolve))),
		});
		const { controller } = controllerFixture({ viewport });
		controller.prepareInitialBottomRestore('chat-1');
		const navigation = controller.jumpToDomAnchor('tool-input-9');
		await vi.waitFor(() => expect(viewport.scrollToTarget).toHaveBeenCalledOnce());
		const dispose = mountInitialBottomRestoreEffect(controller);
		try {
			await tick();
			expect(viewport.restoreInitialEnd).not.toHaveBeenCalled();

			resolveTarget('completed');
			await navigation;
			await tick();
			expect(viewport.restoreInitialEnd).toHaveBeenCalledOnce();
		} finally {
			dispose();
		}
	});

	it('clears initial restoration when loading ends empty', () => {
		const { controller } = controllerFixture({
			state: { displayMessageCount: 0, isLoadingMessages: false, loadStatus: 'empty' },
		});
		controller.prepareInitialBottomRestore('chat-1');
		controller.reconcileInitialBottomRestore(true);
		expect(controller.isPreparingInitialScroll).toBe(false);
	});

	it('navigates to the initial window before scrolling to its start', async () => {
		const navigateToWindow = vi.fn(async () => 'loaded' as const);
		const { controller, viewport, state } = controllerFixture({
			state: { navigateToWindow },
		});
		await controller.scrollToTop();
		expect(navigateToWindow).toHaveBeenCalledWith('chat-1', 'initial');
		expect(viewport.scrollToStart).toHaveBeenCalledOnce();
		expect(state.isUserScrolledUp).toBe(true);
	});

	it('preserves committed initial-window policy when layout settling is superseded', async () => {
		const observed: {
			controller: ConversationScrollController | null;
			state: ConversationScrollState | null;
		} = { controller: null, state: null };
		const navigateToWindow = vi.fn(async () => {
			if (!observed.state || !observed.controller) throw new Error('Fixture is not ready.');
			observed.state.isUserScrolledUp = true;
			observed.controller.reconcilePinnedProjection();
			return 'loaded' as const;
		});
		const fixture = controllerFixture({
			viewport: fakeViewport({
				waitForLayout: vi.fn<ConversationViewportPort['waitForLayout']>(async () => 'superseded'),
			}),
			state: { navigateToWindow },
		});
		observed.controller = fixture.controller;
		observed.state = fixture.state;

		await fixture.controller.scrollToTop();

		expect(fixture.state.isUserScrolledUp).toBe(true);
		expect(fixture.controller.isPinnedToBottom).toBe(false);
		expect(fixture.viewport.scrollToStart).toHaveBeenCalledOnce();
	});

	it('navigates to latest without trimming the expanded interval', async () => {
		const chatState = expandedTranscriptState();
		chatState.hasLaterMessages = true;
		const expectedOrdinals = chatState.entries.map((entry) => entry.ordinal);
		const navigateToWindow = vi.spyOn(chatState, 'navigateToWindow').mockImplementation(async () => {
			chatState.hasLaterMessages = false;
			return 'loaded' as const;
		});
		const fixture = controllerFixture({
			chatState,
			viewport: fakeViewport({ isAtEnd: vi.fn(() => true) }),
		});
		const { controller, viewport } = fixture;
		await controller.scrollToLatest();
		expect(navigateToWindow).toHaveBeenCalledWith('chat-1', 'latest');
		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
		expect(chatState.entries.map((entry) => entry.ordinal)).toEqual(expectedOrdinals);
	});

	it('scrolls to an already-loaded latest edge without trimming the expanded interval', async () => {
		const chatState = expandedTranscriptState();
		const expectedOrdinals = chatState.entries.map((entry) => entry.ordinal);
		const navigateToWindow = vi.spyOn(chatState, 'navigateToWindow');
		const { controller, viewport } = controllerFixture({
			chatState,
			viewport: fakeViewport({ isAtEnd: vi.fn(() => true) }),
		});

		await controller.scrollToLatest();

		expect(navigateToWindow).not.toHaveBeenCalled();
		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();
		expect(chatState.entries.map((entry) => entry.ordinal)).toEqual(expectedOrdinals);
	});

	it('finishes committed latest navigation when layout settling is superseded', async () => {
		const observed: {
			controller: ConversationScrollController | null;
			state: ConversationScrollState | null;
		} = { controller: null, state: null };
		const navigateToWindow = vi.fn(async () => {
			if (!observed.state || !observed.controller) throw new Error('Fixture is not ready.');
			observed.state.isUserScrolledUp = false;
			observed.controller.reconcilePinnedProjection();
			return 'loaded' as const;
		});
		const fixture = controllerFixture({
			viewport: fakeViewport({
				waitForLayout: vi.fn<ConversationViewportPort['waitForLayout']>(async () => 'superseded'),
			}),
			state: { hasLaterMessages: true, isUserScrolledUp: true, navigateToWindow },
		});
		observed.controller = fixture.controller;
		observed.state = fixture.state;
		fixture.controller.setPinnedToBottom(false);

		await fixture.controller.scrollToLatest();

		expect(fixture.state.isUserScrolledUp).toBe(false);
		expect(fixture.controller.isPinnedToBottom).toBe(true);
		expect(fixture.viewport.scrollToEnd).toHaveBeenCalledOnce();
	});

	it('ignores intent that predates a committed latest-window end scroll', async () => {
		const observed: { fixture: ReturnType<typeof controllerFixture> | null } = { fixture: null };
		const navigateToWindow = vi.fn(async () => {
			if (!observed.fixture) throw new Error('Fixture is not ready.');
			observed.fixture.state.hasLaterMessages = false;
			return 'loaded' as const;
		});
		const fixture = controllerFixture({
			viewport: fakeViewport({ isAtEnd: vi.fn(() => true) }),
			state: { hasLaterMessages: true, isUserScrolledUp: true, navigateToWindow },
		});
		observed.fixture = fixture;
		fixture.controller.setPinnedToBottom(false);
		fixture.controller.noteUserScrollIntent('earlier');

		await fixture.controller.scrollToLatest();
		fixture.controller.handleScroll();

		expect(fixture.state.isUserScrolledUp).toBe(false);
		expect(fixture.controller.isPinnedToBottom).toBe(true);
	});

	it('lets user intent cancel a pending latest-window navigation', async () => {
		let resolveNavigation!: (result: 'loaded') => void;
		const navigateToWindow = vi.fn(
			() => new Promise<'loaded'>((resolve) => (resolveNavigation = resolve)),
		);
		const fixture = controllerFixture({
			state: { hasLaterMessages: true, isUserScrolledUp: true, navigateToWindow },
		});
		fixture.controller.setPinnedToBottom(false);

		const navigation = fixture.controller.scrollToLatest();
		await vi.waitFor(() => expect(navigateToWindow).toHaveBeenCalledOnce());
		fixture.controller.noteUserScrollIntent('earlier');
		resolveNavigation('loaded');
		await navigation;

		expect(fixture.viewport.scrollToEnd).not.toHaveBeenCalled();
		expect(fixture.state.invalidatePendingWindowNavigation).toHaveBeenCalledTimes(2);
	});

	it('scrolls the feed half a viewport in either direction', () => {
		const scroller = document.createElement('div');
		Object.defineProperty(scroller, 'clientHeight', { value: 600 });
		const { controller, viewport } = controllerFixture({ scroller });

		controller.scrollFeedHalfPage('earlier');
		expect(viewport.scrollBy).toHaveBeenCalledWith(-300);

		controller.scrollFeedHalfPage('later');
		expect(viewport.scrollBy).toHaveBeenLastCalledWith(300);
	});

	it('reconciles pinned state after a viewport-owned half-page scroll', () => {
		const scroller = document.createElement('div');
		Object.defineProperty(scroller, 'clientHeight', { value: 600 });
		document.body.append(scroller);
		scroller.tabIndex = -1;
		scroller.focus();
		let atEnd = false;
		const viewport = fakeViewport({
			isAtEnd: vi.fn(() => atEnd),
			ownsScrollPosition: vi.fn(() => true),
		});
		const { controller, state } = controllerFixture({ scroller, viewport });

		controller.scrollFeedHalfPage('earlier');
		expect(controller.isPinnedToBottom).toBe(false);
		expect(state.isUserScrolledUp).toBe(true);

		atEnd = true;
		controller.scrollFeedHalfPage('later');
		expect(controller.isPinnedToBottom).toBe(true);
		expect(state.isUserScrolledUp).toBe(false);
		expect(viewport.scrollToEnd).toHaveBeenCalledOnce();

		scroller.remove();
	});

	it('leaves focus policy to the workspace shortcut router', () => {
		const scroller = document.createElement('div');
		Object.defineProperty(scroller, 'clientHeight', { value: 600 });
		document.body.append(scroller);
		const outside = document.createElement('button');
		const textarea = document.createElement('textarea');
		document.body.append(outside, textarea);
		const { controller, viewport } = controllerFixture({ scroller });

		outside.focus();
		controller.scrollFeedHalfPage('later');

		textarea.focus();
		controller.scrollFeedHalfPage('later');
		expect(viewport.scrollBy).toHaveBeenCalledTimes(2);
		expect(viewport.scrollBy).toHaveBeenLastCalledWith(300);

		scroller.remove();
		outside.remove();
		textarea.remove();
	});
});
