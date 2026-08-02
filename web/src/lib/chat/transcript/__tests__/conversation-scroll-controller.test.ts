import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	ConversationScrollController,
	type ConversationScrollState,
} from '../conversation-scroll-controller.svelte';

function scrollState<T extends Partial<ConversationScrollState>>(
	overrides: T,
): T & ConversationScrollState {
	const complete = {
		compactToRecentMessages: vi.fn(() => false),
		canAutoFillEarlier: false,
		canLoadEarlier: false,
		canLoadLater: false,
		displayMessageCount: 0,
		generationId: 'generation-1',
		windowRevision: 0,
		hasInitialMessagesToReveal: false,
		isLoadingMessages: false,
		isUserScrolledUp: false,
		hasLaterMessages: false,
		invalidatePendingHistoryLoad: vi.fn(),
		revealEarlierLoadedRows: vi.fn(() => false),
		loadLaterPage: vi.fn(async () => 'exhausted' as const),
		loadEarlierPage: vi.fn(async () => 'exhausted' as const),
		loadStatus: 'loaded' as const,
		navigateToWindow: vi.fn(async () => 'loaded' as const),
		pageStates: {
			earlier: { status: 'idle' as const, error: null },
			later: { status: 'idle' as const, error: null },
		},
		...overrides,
	} satisfies ConversationScrollState;
	return Object.assign(overrides, complete);
}

class ResizeObserverStub {
	static instances: ResizeObserverStub[] = [];

	callback: ResizeObserverCallback;
	observed: Element[] = [];
	disconnected = false;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		ResizeObserverStub.instances.push(this);
	}

	observe(target: Element) {
		this.observed.push(target);
	}

	disconnect() {
		this.disconnected = true;
	}

	emit(height: number) {
		const target = this.observed[0];
		if (!target) throw new Error('No observed target');
		this.callback(
			[
				{
					target,
					contentRect: { height } as DOMRectReadOnly,
				} as ResizeObserverEntry,
			],
			this as unknown as ResizeObserver,
		);
	}
}

describe('ConversationScrollController', () => {
	const originalResizeObserver = globalThis.ResizeObserver;
	const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
	const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

	beforeEach(() => {
		ResizeObserverStub.instances = [];
		globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
		globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
			cb(0);
			return 1;
		}) as typeof requestAnimationFrame;
		globalThis.cancelAnimationFrame = vi.fn() as typeof cancelAnimationFrame;
	});

	afterEach(() => {
		globalThis.ResizeObserver = originalResizeObserver;
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
	});

	it('keeps the viewport pinned to bottom when the queue controls height changes', () => {
		const scrollToBottom = vi.spyOn(ConversationScrollController.prototype, 'scrollToBottom');
		const scroller = { scrollTop: 120, scrollHeight: 640, clientHeight: 520 } as HTMLDivElement;
		const queue = { offsetHeight: 200 } as HTMLDivElement;

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => queue,
			chatState: scrollState({ isUserScrolledUp: false }),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(true);
		const cleanup = controller.observeQueueResize();
		expect(cleanup).toBeTypeOf('function');

		ResizeObserverStub.instances[0]?.emit(260);

		expect(scrollToBottom).toHaveBeenCalledTimes(1);
		cleanup?.();
		scrollToBottom.mockRestore();
	});

	it('preserves the viewport anchor when the queue controls height changes while scrolled up', () => {
		const scroller = { scrollTop: 120, scrollHeight: 800, clientHeight: 400 } as HTMLDivElement;
		const queue = { offsetHeight: 200 } as HTMLDivElement;

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => queue,
			chatState: scrollState({ isUserScrolledUp: true }),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(false);
		const cleanup = controller.observeQueueResize();
		ResizeObserverStub.instances[0]?.emit(260);

		expect(scroller.scrollTop).toBe(180);
		cleanup?.();
	});

	it('releases expanded transcript history when returning to the live edge', async () => {
		const scroller = { scrollTop: 120, scrollHeight: 900, clientHeight: 400 } as HTMLDivElement;
		const chatState = scrollState({
			isUserScrolledUp: true,
			compactToRecentMessages: vi.fn(() => true),
		});
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState,
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.scrollToBottom();
		expect(chatState.compactToRecentMessages).not.toHaveBeenCalled();

		chatState.isUserScrolledUp = true;
		await controller.scrollToLatest();

		expect(scroller.scrollTop).toBe(900);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
		expect(chatState.compactToRecentMessages).toHaveBeenCalledOnce();
	});

	it('preserves the viewport anchor after older messages render', async () => {
		const scroller = { scrollTop: 40, scrollHeight: 800, clientHeight: 400 } as HTMLDivElement;
		const chatState = {
			canAutoFillEarlier: true,
			canLoadEarlier: true,
			isUserScrolledUp: true,
			loadEarlierPage: vi.fn(async () => {
				Object.defineProperty(scroller, 'scrollHeight', { value: 1100, configurable: true });
				return 'loaded' as const;
			}),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(false);
		await controller.requestPage('earlier', 'button');

		expect(chatState.loadEarlierPage).toHaveBeenCalledWith('chat-1');
		expect(scroller.scrollTop).toBe(340);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('keeps a pinned viewport at the bottom during navigator pagination', async () => {
		let scrollHeight = 800;
		const scroller = { scrollTop: 400, clientHeight: 400 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			isUserScrolledUp: false,
			loadEarlierPage: vi.fn(async () => {
				scrollHeight = 1_100;
				return 'loaded' as const;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(true);

		expect(await controller.loadEarlierPageForNavigator('chat-1')).toBe('loaded');

		expect(scroller.scrollTop).toBe(1_100);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('preserves a scrolled-up viewport during navigator pagination', async () => {
		let scrollHeight = 800;
		const scroller = { scrollTop: 160, clientHeight: 400 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			canLoadEarlier: true,
			isUserScrolledUp: true,
			loadEarlierPage: vi.fn(async () => {
				scrollHeight = 1_050;
				return 'loaded' as const;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(false);

		expect(await controller.loadEarlierPageForNavigator('chat-1')).toBe('loaded');

		expect(scroller.scrollTop).toBe(410);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('does not restore navigator pagination after a newer scroll-to-top operation', async () => {
		let scrollHeight = 800;
		let resolveLoad!: (result: 'loaded') => void;
		const load = new Promise<'loaded'>((resolve) => {
			resolveLoad = resolve;
		});
		const scroller = { scrollTop: 160, clientHeight: 400 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			canLoadEarlier: false,
			isUserScrolledUp: true,
			loadEarlierPage: vi.fn(() => load),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(false);

		const pagination = controller.loadEarlierPageForNavigator('chat-1');
		await controller.scrollToTop();
		scrollHeight = 1_100;
		resolveLoad('loaded');

		expect(await pagination).toBe('invalidated');
		expect(scroller.scrollTop).toBe(0);
	});

	it('discards a navigator page that resolves after a message jump', async () => {
		let scrollHeight = 800;
		let invalidated = false;
		let resolvePage!: () => void;
		const page = new Promise<void>((resolve) => {
			resolvePage = resolve;
		});
		const scroller = {
			scrollTop: 200,
			clientHeight: 400,
			getBoundingClientRect: () => ({ top: 100 }),
		} as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const content = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatRowId = 'generation-1:7';
		row.getBoundingClientRect = vi.fn(() => ({ top: 350, height: 100 }) as DOMRect);
		content.append(row);
		const chatState = {
			generationId: 'generation-1',
			isUserScrolledUp: true,
			invalidatePendingHistoryLoad: vi.fn(() => {
				invalidated = true;
			}),
			loadEarlierPage: vi.fn(async () => {
				await page;
				if (invalidated) return 'invalidated' as const;
				scrollHeight = 1_100;
				return 'loaded' as const;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(false);

		const pagination = controller.loadEarlierPageForNavigator('chat-1');
		expect(
			await controller.jumpToMessageRow({
				chatId: 'chat-1',
				generationId: 'generation-1',
				rowId: 'generation-1:7',
			}),
		).toBe(true);
		resolvePage();

		expect(await pagination).toBe('invalidated');
		expect(chatState.invalidatePendingHistoryLoad).toHaveBeenCalledOnce();
		expect(scrollHeight).toBe(800);
		expect(scroller.scrollTop).toBe(300);
	});

	it('centers a generation-scoped message row inside the active feed', async () => {
		const scroller = {
			scrollTop: 200,
			scrollHeight: 1_200,
			clientHeight: 400,
			getBoundingClientRect: () => ({ top: 100 }),
		} as HTMLDivElement;
		const content = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatRowId = 'generation-1:7';
		row.getBoundingClientRect = vi.fn(() => ({ top: 350, height: 100 }) as DOMRect);
		content.append(row);
		const chatState = { generationId: 'generation-1', isUserScrolledUp: false };
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(true);

		expect(
			await controller.jumpToMessageRow({
				chatId: 'chat-1',
				generationId: 'generation-1',
				rowId: 'generation-1:7',
			}),
		).toBe(true);

		expect(scroller.scrollTop).toBe(300);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('does not cancel a message jump when bottom sync runs on the latest window', async () => {
		const scroller = {
			scrollTop: 200,
			scrollHeight: 1_200,
			clientHeight: 400,
			getBoundingClientRect: () => ({ top: 100 }),
		} as HTMLDivElement;
		const content = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatRowId = 'generation-1:7';
		row.getBoundingClientRect = vi.fn(() => ({ top: 350, height: 100 }) as DOMRect);
		content.append(row);
		const chatState = {
			generationId: 'generation-1',
			isUserScrolledUp: false,
			hasLaterMessages: false,
			navigateToWindow: vi.fn(async () => 'loaded' as const),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		const jump = controller.jumpToMessageRow({
			chatId: 'chat-1',
			generationId: 'generation-1',
			rowId: 'generation-1:7',
		});
		const bottomSync = controller.scrollToLatest();

		expect(await jump).toBe(true);
		await bottomSync;
		expect(chatState.navigateToWindow).not.toHaveBeenCalled();
	});

	it('jumps to a pending row before the first transcript generation exists', async () => {
		const scroller = {
			scrollTop: 0,
			scrollHeight: 800,
			clientHeight: 400,
			getBoundingClientRect: () => ({ top: 0 }),
		} as HTMLDivElement;
		const content = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatRowId = 'pending:request-1';
		row.getBoundingClientRect = vi.fn(() => ({ top: 100, height: 100 }) as DOMRect);
		content.append(row);
		const chatState = { generationId: '', isUserScrolledUp: false };
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		expect(
			await controller.jumpToMessageRow({
				chatId: 'chat-1',
				generationId: '',
				rowId: 'pending:request-1',
			}),
		).toBe(true);
	});

	it('rejects stale or missing message-row targets without changing pin state', async () => {
		const scroller = { scrollTop: 200, scrollHeight: 1_200, clientHeight: 400 } as HTMLDivElement;
		const content = document.createElement('div');
		const outside = document.createElement('div');
		outside.dataset.chatRowId = 'generation-1:7';
		document.body.append(outside);
		const chatState = { generationId: 'generation-1', isUserScrolledUp: false };
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(true);

		expect(
			await controller.jumpToMessageRow({
				chatId: 'chat-1',
				generationId: 'generation-2',
				rowId: 'generation-1:7',
			}),
		).toBe(false);
		expect(
			await controller.jumpToMessageRow({
				chatId: 'chat-1',
				generationId: 'generation-1',
				rowId: 'generation-1:7',
			}),
		).toBe(false);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
		outside.remove();
	});

	it('treats scroll-to-top as an intentional user scroll', async () => {
		const scroller = { scrollTop: 800, scrollHeight: 1200, clientHeight: 400 } as HTMLDivElement;
		const chatState = {
			canLoadEarlier: false,
			isUserScrolledUp: false,
			navigateToWindow: vi.fn(async () => 'loaded' as const),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(true);
		await controller.scrollToTop();

		expect(scroller.scrollTop).toBe(0);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
		expect(controller.isScrollingToTop).toBe(false);
		expect(chatState.navigateToWindow).toHaveBeenCalledWith('chat-1', 'initial');
	});

	it('reloads the latest window before scrolling down from the initial page', async () => {
		let scrollHeight = 1_200;
		const scroller = { scrollTop: 0, clientHeight: 400 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			isUserScrolledUp: true,
			hasLaterMessages: true,
			navigateToWindow: vi.fn(async (_chatId: string, target: 'initial' | 'latest') => {
				expect(target).toBe('latest');
				chatState.hasLaterMessages = false;
				scrollHeight = 1_600;
				return 'loaded' as const;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(false);

		await controller.scrollToLatest();

		expect(chatState.navigateToWindow).toHaveBeenCalledWith('chat-1', 'latest');
		expect(scroller.scrollTop).toBe(1_600);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('replaces the retained reveal with the bounded initial window before scrolling', async () => {
		const scroller = { scrollTop: 800, scrollHeight: 1200, clientHeight: 400 } as HTMLDivElement;
		const chatState = {
			hasInitialMessagesToReveal: true,
			canLoadEarlier: false,
			isUserScrolledUp: true,
			navigateToWindow: vi.fn(async () => 'loaded' as const),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		await controller.scrollToTop();

		expect(chatState.navigateToWindow).toHaveBeenCalledWith('chat-1', 'initial');
		expect(scroller.scrollTop).toBe(0);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('waits for the bounded initial window before scrolling to its first row', async () => {
		let resolveInitial!: () => void;
		const initialLoad = new Promise<'loaded'>((resolve) => {
			resolveInitial = () => resolve('loaded');
		});
		const chatState = {
			isUserScrolledUp: true,
			navigateToWindow: vi.fn(() => initialLoad),
		};
		const scroller = { scrollTop: 800, scrollHeight: 1600, clientHeight: 400 } as HTMLDivElement;
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		const scrollToTop = controller.scrollToTop();
		expect(scroller.scrollTop).toBe(800);

		resolveInitial();
		await scrollToTop;

		expect(scroller.scrollTop).toBe(0);
	});

	it('honors Bottom when it supersedes a pending Initial navigation', async () => {
		let resolveInitial!: () => void;
		const initial = new Promise<'loaded'>((resolve) => {
			resolveInitial = () => resolve('loaded');
		});
		const chatState = {
			isUserScrolledUp: false,
			navigateToWindow: vi.fn((_chatId: string, target: 'initial' | 'latest') =>
				target === 'initial' ? initial : Promise.resolve('loaded' as const),
			),
		};
		const scroller = { scrollTop: 600, scrollHeight: 1_200, clientHeight: 400 } as HTMLDivElement;
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		const toInitial = controller.scrollToTop();
		await controller.scrollToLatest();
		resolveInitial();
		await toInitial;

		expect(chatState.navigateToWindow.mock.calls).toEqual([
			['chat-1', 'initial'],
			['chat-1', 'latest'],
		]);
		expect(scroller.scrollTop).toBe(1_200);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('honors Initial when it supersedes a pending Bottom navigation', async () => {
		let resolveLatest!: () => void;
		const latest = new Promise<'loaded'>((resolve) => {
			resolveLatest = () => resolve('loaded');
		});
		const chatState = {
			isUserScrolledUp: true,
			hasLaterMessages: true,
			navigateToWindow: vi.fn((_chatId: string, target: 'initial' | 'latest') =>
				target === 'latest' ? latest : Promise.resolve('loaded' as const),
			),
		};
		const scroller = { scrollTop: 0, scrollHeight: 1_200, clientHeight: 400 } as HTMLDivElement;
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		const toLatest = controller.scrollToLatest();
		await controller.scrollToTop();
		resolveLatest();
		await toLatest;

		expect(chatState.navigateToWindow.mock.calls).toEqual([
			['chat-1', 'latest'],
			['chat-1', 'initial'],
		]);
		expect(scroller.scrollTop).toBe(0);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('does not snap to bottom from an untagged scroll event', () => {
		const scroller = { scrollTop: 500, scrollHeight: 1200, clientHeight: 400 } as HTMLDivElement;
		const chatState = {
			isUserScrolledUp: false,
			canLoadEarlier: false,
			loadEarlierPage: vi.fn(),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(true);
		controller.handleScroll();

		expect(scroller.scrollTop).toBe(500);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('loads one later page for a deliberate detached-window boundary encounter', () => {
		const scroller = { scrollTop: 800, scrollHeight: 1_200, clientHeight: 400 } as HTMLDivElement;
		const chatState = {
			canLoadLater: true,
			isUserScrolledUp: false,
			hasLaterMessages: true,
			loadLaterPage: vi.fn(async () => 'loaded' as const),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(true);

		controller.noteUserScrollIntent('later');
		controller.handleScroll();

		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
		expect(chatState.loadLaterPage).toHaveBeenCalledWith('chat-1');
	});

	it('does not follow or compact after a short final page reaches the live head', async () => {
		let scrollHeight = 1_200;
		let resolvePage!: (result: 'loaded') => void;
		const page = new Promise<'loaded'>((resolve) => {
			resolvePage = resolve;
		});
		const scroller = { scrollTop: 800, clientHeight: 400 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = scrollState({
			isUserScrolledUp: true,
			hasLaterMessages: true as boolean,
			canLoadLater: true as boolean,
			compactToRecentMessages: vi.fn(() => true),
			loadLaterPage: vi.fn(() => page),
		});
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState,
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(false);

		const pagination = controller.requestPage('later', 'button');
		await vi.waitFor(() => expect(chatState.loadLaterPage).toHaveBeenCalledOnce());

		scrollHeight = 1_240;
		chatState.hasLaterMessages = false;
		chatState.canLoadLater = false;
		controller.noteUserScrollIntent('later');
		controller.handleScroll();
		resolvePage('loaded');
		await expect(pagination).resolves.toBe('loaded');
		controller.handleScroll();

		expect(chatState.compactToRecentMessages).not.toHaveBeenCalled();
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
		expect(scroller.scrollTop).toBe(800);

		controller.noteUserScrollIntent('later');
		controller.handleScroll();

		await vi.waitFor(() => {
			expect(chatState.compactToRecentMessages).toHaveBeenCalledOnce();
			expect(scroller.scrollTop).toBe(1_240);
		});
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('preserves the same durable row when a later page is appended', async () => {
		let scrollHeight = 1_200;
		const scroller = {
			scrollTop: 800,
			clientHeight: 400,
			getBoundingClientRect: () => ({ top: 0 }),
		} as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const content = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatAnchorId = 'generation-1:40';
		const rowDocumentTop = 900;
		row.getBoundingClientRect = () =>
			({
				top: rowDocumentTop - scroller.scrollTop,
				bottom: rowDocumentTop - scroller.scrollTop + 40,
			}) as DOMRect;
		content.append(row);
		const chatState = scrollState({
			canLoadLater: true,
			hasLaterMessages: true,
			isUserScrolledUp: true,
			loadLaterPage: vi.fn(async () => {
				scrollHeight = 1_600;
				return 'loaded' as const;
			}),
		});
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState,
			sessions: { selectedChatId: 'chat-1' },
		});

		await controller.requestPage('later', 'button');

		expect(scroller.scrollTop).toBe(800);
		expect(row.getBoundingClientRect().top).toBe(100);
		expect(chatState.isUserScrolledUp).toBe(true);
	});

	it('preserves the same durable row when an earlier page is prepended', async () => {
		let scrollHeight = 1_200;
		let rowDocumentTop = 900;
		const scroller = {
			scrollTop: 800,
			clientHeight: 400,
			getBoundingClientRect: () => ({ top: 0 }),
		} as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const content = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatAnchorId = 'generation-1:80';
		row.getBoundingClientRect = () =>
			({
				top: rowDocumentTop - scroller.scrollTop,
				bottom: rowDocumentTop - scroller.scrollTop + 40,
			}) as DOMRect;
		content.append(row);
		const chatState = scrollState({
			canLoadEarlier: true,
			isUserScrolledUp: true,
			loadEarlierPage: vi.fn(async () => {
				scrollHeight = 1_500;
				rowDocumentTop += 300;
				return 'loaded' as const;
			}),
		});
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState,
			sessions: { selectedChatId: 'chat-1' },
		});

		await controller.requestPage('earlier', 'button');

		expect(scroller.scrollTop).toBe(1_100);
		expect(row.getBoundingClientRect().top).toBe(100);
		expect(chatState.isUserScrolledUp).toBe(true);
	});

	it('does not restore a reveal anchor after the transcript window is replaced', async () => {
		let rowDocumentTop = 100;
		const scroller = {
			scrollTop: 0,
			scrollHeight: 600,
			clientHeight: 400,
			getBoundingClientRect: () => ({ top: 0 }),
		} as HTMLDivElement;
		const content = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatAnchorId = 'generation-1:80';
		row.getBoundingClientRect = () =>
			({ top: rowDocumentTop - scroller.scrollTop, bottom: rowDocumentTop + 40 }) as DOMRect;
		content.append(row);
		const chatState = scrollState({
			canLoadEarlier: true,
			isUserScrolledUp: true,
			revealEarlierLoadedRows: vi.fn(() => true),
		});
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState,
			sessions: { selectedChatId: 'chat-1' },
		});

		const reveal = controller.requestPage('earlier', 'button');
		rowDocumentTop = 400;
		chatState.windowRevision += 1;

		await expect(reveal).resolves.toBe('invalidated');
		expect(scroller.scrollTop).toBe(0);
	});

	it('requires a later boundary to leave the activation zone before loading again', async () => {
		let scrollHeight = 1_200;
		const scroller = { scrollTop: 800, clientHeight: 400 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = scrollState({
			canLoadLater: true,
			hasLaterMessages: true,
			isUserScrolledUp: true,
			loadLaterPage: vi.fn(async () => {
				scrollHeight += 40;
				return 'loaded' as const;
			}),
		});
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState,
			sessions: { selectedChatId: 'chat-1' },
		});

		await controller.requestPage('later', 'button');
		expect(chatState.loadLaterPage).toHaveBeenCalledOnce();

		controller.noteUserScrollIntent('later');
		controller.handleScroll();
		expect(chatState.loadLaterPage).toHaveBeenCalledOnce();

		scroller.scrollTop = 600;
		controller.noteUserScrollIntent('earlier');
		controller.handleScroll();
		scroller.scrollTop = 840;
		controller.noteUserScrollIntent('later');
		controller.handleScroll();

		await vi.waitFor(() => expect(chatState.loadLaterPage).toHaveBeenCalledTimes(2));
	});

	it('fills an underfilled detached initial window without pinning it', async () => {
		let scrollHeight = 300;
		const scroller = { scrollTop: 0, clientHeight: 500 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			canLoadLater: true,
			canLoadEarlier: true,
			isUserScrolledUp: false,
			hasLaterMessages: true,
			loadLaterPage: vi.fn(async () => {
				scrollHeight = 700;
				return 'loaded' as const;
			}),
			loadEarlierPage: vi.fn(async () => 'loaded' as const),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(true);

		await controller.fillUnderfilledViewport();

		expect(chatState.loadLaterPage).toHaveBeenCalledOnce();
		expect(chatState.loadEarlierPage).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(0);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('stops detached underfill when the viewport becomes hidden', async () => {
		let scrollHeight = 300;
		let resolvePage!: (result: 'loaded') => void;
		const firstPage = new Promise<'loaded'>((resolve) => {
			resolvePage = resolve;
		});
		const scroller = { scrollTop: 0, clientHeight: 500 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = scrollState({
			isUserScrolledUp: true,
			hasLaterMessages: true,
			loadLaterPage: vi
				.fn()
				.mockReturnValueOnce(firstPage)
				.mockResolvedValue('loaded' as const),
		});
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState,
			sessions: { selectedChatId: 'chat-1' },
		});

		const fill = controller.fillUnderfilledViewport();
		await vi.waitFor(() => expect(chatState.loadLaterPage).toHaveBeenCalledOnce());
		controller.setViewportVisible(false);
		scrollHeight = 350;
		resolvePage('loaded');
		await fill;

		expect(chatState.loadLaterPage).toHaveBeenCalledOnce();
	});

	it('stops live underfill when the viewport becomes hidden', async () => {
		let scrollHeight = 300;
		let resolvePage!: (result: 'loaded') => void;
		const firstPage = new Promise<'loaded'>((resolve) => {
			resolvePage = resolve;
		});
		const scroller = { scrollTop: 0, clientHeight: 500 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = scrollState({
			canAutoFillEarlier: true,
			isUserScrolledUp: false,
			loadEarlierPage: vi
				.fn()
				.mockReturnValueOnce(firstPage)
				.mockResolvedValue('loaded' as const),
		});
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState,
			sessions: { selectedChatId: 'chat-1' },
		});

		const fill = controller.fillUnderfilledViewport();
		await vi.waitFor(() => expect(chatState.loadEarlierPage).toHaveBeenCalledOnce());
		controller.setViewportVisible(false);
		scrollHeight = 350;
		resolvePage('loaded');
		await fill;

		expect(chatState.loadEarlierPage).toHaveBeenCalledOnce();
	});

	it('retries a failed detached viewport fill after the viewport becomes visible', async () => {
		let scrollHeight = 300;
		const scroller = { scrollTop: 0, clientHeight: 500 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = scrollState({
			isUserScrolledUp: true,
			hasLaterMessages: true,
			loadLaterPage: vi
				.fn()
				.mockResolvedValueOnce('failed' as const)
				.mockImplementationOnce(async () => {
					scrollHeight = 700;
					return 'loaded' as const;
				}),
		});
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState,
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(false);

		await controller.fillUnderfilledViewport();
		expect(chatState.loadLaterPage).toHaveBeenCalledOnce();

		controller.setViewportVisible(false);
		controller.setViewportVisible(true);

		await vi.waitFor(() => expect(chatState.loadLaterPage).toHaveBeenCalledTimes(2));
		expect(scrollHeight).toBe(700);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('tracks initial bottom restoration only for the selected chat with rendered rows', () => {
		const chatState = {
			isUserScrolledUp: false,
			displayMessageCount: 3,
			loadStatus: 'loaded' as const,
			isLoadingMessages: false,
		};
		const sessions = { selectedChatId: 'chat-1' };
		const controller = new ConversationScrollController({
			getScrollContainer: () => null,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions,
		});

		controller.prepareInitialBottomRestore('chat-1');
		expect(controller.isPreparingInitialScroll).toBe(true);

		sessions.selectedChatId = 'chat-2';
		expect(controller.isPreparingInitialScroll).toBe(false);
	});

	it('clears initial bottom restoration after the first anchored restore', () => {
		const chatState = {
			isUserScrolledUp: false,
			displayMessageCount: 3,
			loadStatus: 'loaded' as const,
			isLoadingMessages: false,
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => null,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.prepareInitialBottomRestore('chat-1');
		controller.completeInitialBottomRestore();

		expect(controller.isPreparingInitialScroll).toBe(false);
	});

	it('restores the bottom synchronously when pinned content height changes', () => {
		const requestAnimationFrame = vi.fn(() => 1);
		globalThis.requestAnimationFrame =
			requestAnimationFrame as unknown as typeof globalThis.requestAnimationFrame;
		const scroller = { scrollTop: 500, scrollHeight: 1200, clientHeight: 400 } as HTMLDivElement;
		const content = { offsetHeight: 800 } as HTMLDivElement;
		const chatState = {
			isUserScrolledUp: false,
			canLoadEarlier: false,
			loadEarlierPage: vi.fn(),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(true);
		const cleanup = controller.observeScrollContentResize();
		ResizeObserverStub.instances[0]?.emit(900);

		expect(requestAnimationFrame).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(1200);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
		cleanup?.();
	});

	it('treats a scroll away from bottom as user-scrolled after user intent', () => {
		const scroller = { scrollTop: 500, scrollHeight: 1200, clientHeight: 400 } as HTMLDivElement;
		const chatState = {
			isUserScrolledUp: false,
			canLoadEarlier: false,
			loadEarlierPage: vi.fn(),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(true);
		controller.noteUserScrollIntent();
		controller.handleScroll();

		expect(scroller.scrollTop).toBe(500);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('does not paginate while the initial transcript reveal is incomplete', () => {
		const scroller = { scrollTop: 40, scrollHeight: 800, clientHeight: 400 } as HTMLDivElement;
		const chatState = {
			hasInitialMessagesToReveal: true,
			canLoadEarlier: false,
			isUserScrolledUp: true,
			loadEarlierPage: vi.fn(async () => 'loaded' as const),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(false);
		controller.noteUserScrollIntent('earlier');
		controller.handleScroll();

		expect(chatState.loadEarlierPage).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(40);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('does not restore a stale pagination anchor over a scroll-to-top request', async () => {
		let scrollHeight = 800;
		let resolveLoad!: (result: 'loaded') => void;
		const pageLoad = new Promise<'loaded'>((resolve) => {
			resolveLoad = resolve;
		});
		const scroller = { scrollTop: 40, clientHeight: 400 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			hasInitialMessagesToReveal: false,
			canLoadEarlier: true,
			isUserScrolledUp: true,
			loadEarlierPage: vi.fn(() => pageLoad),
			navigateToWindow: vi.fn(async () => {
				await pageLoad;
				chatState.canLoadEarlier = false;
				return 'loaded' as const;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(false);
		controller.noteUserScrollIntent('earlier');
		controller.handleScroll();
		await vi.waitFor(() => expect(chatState.loadEarlierPage).toHaveBeenCalledOnce());
		const scrollToTop = controller.scrollToTop();
		await vi.waitFor(() => expect(chatState.navigateToWindow).toHaveBeenCalledOnce());

		scrollHeight = 1500;
		resolveLoad('loaded');
		await scrollToTop;
		await vi.waitFor(() => expect(controller.isScrollingToTop).toBe(false));

		expect(scroller.scrollTop).toBe(0);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('does not restore an older-message anchor after switching chats', async () => {
		const scroller = { scrollTop: 40, scrollHeight: 800, clientHeight: 400 } as HTMLDivElement;
		const sessions = { selectedChatId: 'chat-1' };
		const chatState = {
			canLoadEarlier: true,
			isUserScrolledUp: true,
			loadEarlierPage: vi.fn(async () => {
				sessions.selectedChatId = 'chat-2';
				Object.defineProperty(scroller, 'scrollHeight', { value: 1100, configurable: true });
				return 'loaded' as const;
			}),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions,
		});

		await controller.requestPage('earlier', 'button');

		expect(scroller.scrollTop).toBe(40);
		expect(chatState.loadEarlierPage).toHaveBeenCalledWith('chat-1');
	});

	it('loads older messages until an initially underfilled viewport can scroll', async () => {
		let scrollHeight = 300;
		const scroller = { scrollTop: 0, clientHeight: 500 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			canAutoFillEarlier: true,
			canLoadEarlier: true,
			isUserScrolledUp: false,
			loadEarlierPage: vi.fn(async () => {
				scrollHeight = scrollHeight === 300 ? 450 : 800;
				return 'loaded' as const;
			}),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		await controller.fillUnderfilledViewport();

		expect(chatState.loadEarlierPage).toHaveBeenCalledTimes(2);
		expect(chatState.loadEarlierPage).toHaveBeenCalledWith('chat-1');
		expect(scroller.scrollTop).toBe(800);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('reveals loaded rows before offering manual loading in an underfilled viewport', async () => {
		let scrollHeight = 300;
		const scroller = { scrollTop: 0, clientHeight: 500 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			canAutoFillEarlier: true,
			canLoadEarlier: false,
			isUserScrolledUp: false,
			revealEarlierLoadedRows: vi.fn(() => {
				scrollHeight = 700;
				return true;
			}),
			loadEarlierPage: vi.fn(async () => 'loaded' as const),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		await controller.fillUnderfilledViewport();

		expect(chatState.revealEarlierLoadedRows).toHaveBeenCalledOnce();
		expect(chatState.loadEarlierPage).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(700);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('defers viewport auto-fill until the initial transcript reveal completes', async () => {
		let scrollHeight = 300;
		const scroller = { scrollTop: 0, clientHeight: 500 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			canAutoFillEarlier: true,
			hasInitialMessagesToReveal: true,
			canLoadEarlier: true,
			isUserScrolledUp: false,
			loadEarlierPage: vi.fn(async () => {
				scrollHeight = 800;
				return 'loaded' as const;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		await controller.fillUnderfilledViewport();

		expect(chatState.loadEarlierPage).not.toHaveBeenCalled();

		chatState.hasInitialMessagesToReveal = false;
		await controller.fillUnderfilledViewport();

		expect(chatState.loadEarlierPage).toHaveBeenCalledOnce();
		expect(chatState.loadEarlierPage).toHaveBeenCalledWith('chat-1');
		expect(scroller.scrollTop).toBe(800);
	});

	it('stops viewport auto-fill if the selected chat changes', async () => {
		let scrollHeight = 300;
		const scroller = { scrollTop: 0, clientHeight: 500 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const sessions = { selectedChatId: 'chat-1' };
		const chatState = {
			canAutoFillEarlier: true,
			canLoadEarlier: true,
			isUserScrolledUp: false,
			loadEarlierPage: vi.fn(async () => {
				scrollHeight = 800;
				sessions.selectedChatId = 'chat-2';
				return 'loaded' as const;
			}),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions,
		});

		await controller.fillUnderfilledViewport();

		expect(chatState.loadEarlierPage).toHaveBeenCalledTimes(1);
		expect(scroller.scrollTop).toBe(0);
	});

	it('keeps the viewport pinned to bottom when the scroll container height changes', () => {
		const scrollToBottom = vi.spyOn(ConversationScrollController.prototype, 'scrollToBottom');
		const scroller = { scrollTop: 120, scrollHeight: 800, clientHeight: 520 } as HTMLDivElement;

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState({ isUserScrolledUp: false }),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(true);
		const cleanup = controller.observeScrollContainerResize();
		expect(cleanup).toBeTypeOf('function');

		ResizeObserverStub.instances[0]?.emit(360);

		expect(scrollToBottom).toHaveBeenCalledTimes(1);
		cleanup?.();
		scrollToBottom.mockRestore();
	});

	it('does not repin the viewport on scroll container resize when the user scrolled up', () => {
		const scrollToBottom = vi.spyOn(ConversationScrollController.prototype, 'scrollToBottom');
		const scroller = { scrollTop: 120, scrollHeight: 800, clientHeight: 520 } as HTMLDivElement;

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState({ isUserScrolledUp: true }),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(false);
		const cleanup = controller.observeScrollContainerResize();

		ResizeObserverStub.instances[0]?.emit(360);

		expect(scrollToBottom).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(120);
		cleanup?.();
		scrollToBottom.mockRestore();
	});

	it('auto-fills an underfilled viewport after the scroll container resizes', () => {
		const fillUnderfilledViewport = vi
			.spyOn(ConversationScrollController.prototype, 'fillUnderfilledViewport')
			.mockResolvedValue(undefined);
		const scroller = { scrollTop: 120, scrollHeight: 480, clientHeight: 520 } as HTMLDivElement;

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState({ isUserScrolledUp: false, canLoadEarlier: true }),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(true);
		const cleanup = controller.observeScrollContainerResize();

		ResizeObserverStub.instances[0]?.emit(640);

		expect(fillUnderfilledViewport).toHaveBeenCalledTimes(1);
		cleanup?.();
		fillUnderfilledViewport.mockRestore();
	});

	it('keeps the viewport pinned to bottom when transcript content height changes', () => {
		const scrollToBottom = vi.spyOn(ConversationScrollController.prototype, 'scrollToBottom');
		const scroller = { scrollTop: 120, scrollHeight: 900, clientHeight: 520 } as HTMLDivElement;
		const content = { offsetHeight: 720 } as HTMLDivElement;

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState: scrollState({ isUserScrolledUp: false, canLoadEarlier: false }),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(true);
		const cleanup = controller.observeScrollContentResize();
		expect(cleanup).toBeTypeOf('function');

		ResizeObserverStub.instances[0]?.emit(860);

		expect(scrollToBottom).toHaveBeenCalledTimes(1);
		cleanup?.();
		scrollToBottom.mockRestore();
	});

	it('does not repin on transcript content resize when the user scrolled up', () => {
		const scrollToBottom = vi.spyOn(ConversationScrollController.prototype, 'scrollToBottom');
		const scroller = { scrollTop: 120, scrollHeight: 900, clientHeight: 520 } as HTMLDivElement;
		const content = { offsetHeight: 720 } as HTMLDivElement;

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState: scrollState({ isUserScrolledUp: true, canLoadEarlier: false }),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(false);
		const cleanup = controller.observeScrollContentResize();

		ResizeObserverStub.instances[0]?.emit(860);

		expect(scrollToBottom).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(120);
		cleanup?.();
		scrollToBottom.mockRestore();
	});

	it('restores bottom pinning when a hidden viewport becomes visible again', () => {
		const scroller = { scrollTop: 400, scrollHeight: 1000, clientHeight: 600 } as HTMLDivElement;
		const chatState = {
			isUserScrolledUp: false,
			canLoadEarlier: false,
			loadEarlierPage: vi.fn(),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(true);
		controller.setViewportVisible(false);
		Object.defineProperty(scroller, 'scrollHeight', { value: 1400, configurable: true });
		scroller.scrollTop = 400;

		controller.setViewportVisible(true);

		expect(scroller.scrollTop).toBe(1400);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('does not let a queued visibility restore undo a message jump', async () => {
		const scheduledFrames: FrameRequestCallback[] = [];
		globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			scheduledFrames.push(callback);
			return scheduledFrames.length;
		}) as typeof requestAnimationFrame;
		const scroller = {
			scrollTop: 200,
			scrollHeight: 705,
			clientHeight: 400,
			getBoundingClientRect: () => ({ top: 100 }),
		} as HTMLDivElement;
		const content = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatRowId = 'generation-1:7';
		row.getBoundingClientRect = vi.fn(() => ({ top: 350, height: 100 }) as DOMRect);
		content.append(row);
		const chatState = { generationId: 'generation-1', isUserScrolledUp: false };
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(true);
		const jump = controller.jumpToMessageRow({
			chatId: 'chat-1',
			generationId: 'generation-1',
			rowId: 'generation-1:7',
		});
		controller.setViewportVisible(false);
		controller.setViewportVisible(true);

		expect(await jump).toBe(true);
		for (const callback of scheduledFrames) callback(0);

		expect(scheduledFrames).toEqual([]);
		expect(scroller.scrollTop).toBe(300);
		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
	});

	it('does not leak jump suppression after completing while hidden', async () => {
		const scheduledFrames: FrameRequestCallback[] = [];
		globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			scheduledFrames.push(callback);
			return scheduledFrames.length;
		}) as typeof requestAnimationFrame;
		let scrollHeight = 1_200;
		const scroller = {
			scrollTop: 200,
			clientHeight: 400,
			getBoundingClientRect: () => ({ top: 100 }),
		} as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const content = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatRowId = 'generation-1:7';
		row.getBoundingClientRect = vi.fn(() => ({ top: 350, height: 100 }) as DOMRect);
		content.append(row);
		const chatState = { generationId: 'generation-1', isUserScrolledUp: false };
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getScrollContentContainer: () => content,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(true);
		controller.setViewportVisible(false);

		expect(
			await controller.jumpToMessageRow({
				chatId: 'chat-1',
				generationId: 'generation-1',
				rowId: 'generation-1:7',
			}),
		).toBe(true);
		controller.setViewportVisible(true);
		expect(scheduledFrames).toEqual([]);

		chatState.isUserScrolledUp = false;
		controller.setPinnedToBottom(true);
		controller.setViewportVisible(false);
		scrollHeight = 1_400;
		controller.setViewportVisible(true);
		expect(scheduledFrames).toHaveLength(1);
		scheduledFrames[0]?.(0);
		expect(scroller.scrollTop).toBe(1_400);
	});

	it('does not restore bottom when the user was scrolled up before hiding the viewport', () => {
		const scroller = { scrollTop: 120, scrollHeight: 1000, clientHeight: 600 } as HTMLDivElement;
		const chatState = {
			isUserScrolledUp: true,
			canLoadEarlier: false,
			loadEarlierPage: vi.fn(),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(false);
		controller.setViewportVisible(false);
		Object.defineProperty(scroller, 'scrollHeight', { value: 1400, configurable: true });

		controller.setViewportVisible(true);

		expect(scroller.scrollTop).toBe(120);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('ignores scroll events while the viewport is hidden', () => {
		const scroller = { scrollTop: 0, scrollHeight: 1000, clientHeight: 600 } as HTMLDivElement;
		const chatState = {
			isUserScrolledUp: false,
			canLoadEarlier: true,
			loadEarlierPage: vi.fn(),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(true);
		controller.setViewportVisible(false);
		controller.handleScroll();

		expect(chatState.isUserScrolledUp).toBe(false);
		expect(controller.isPinnedToBottom).toBe(true);
		expect(chatState.loadEarlierPage).not.toHaveBeenCalled();
	});

	it('keeps Ctrl-U half-page scrolling without consuming Ctrl-D', () => {
		const scroller = document.createElement('div');
		scroller.tabIndex = 0;
		Object.defineProperty(scroller, 'clientHeight', { value: 600 });
		scroller.scrollBy = vi.fn();
		document.body.append(scroller);
		scroller.focus();
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState({}),
			sessions: { selectedChatId: 'chat-1' },
		});

		const scrollUp = new KeyboardEvent('keydown', {
			key: 'u',
			ctrlKey: true,
			cancelable: true,
		});
		controller.handleHalfPageScroll(scrollUp);
		expect(scrollUp.defaultPrevented).toBe(true);
		expect(scroller.scrollBy).toHaveBeenCalledWith({ top: -300, behavior: 'instant' });

		const deleteChat = new KeyboardEvent('keydown', {
			key: 'd',
			ctrlKey: true,
			cancelable: true,
		});
		controller.handleHalfPageScroll(deleteChat);
		expect(deleteChat.defaultPrevented).toBe(false);
		expect(scroller.scrollBy).toHaveBeenCalledOnce();

		scroller.remove();
	});
});
