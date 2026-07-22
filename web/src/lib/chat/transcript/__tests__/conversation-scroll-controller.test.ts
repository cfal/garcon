import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	ConversationScrollController,
	type ConversationScrollState,
} from '../conversation-scroll-controller.svelte';
import { ActiveTranscriptState } from '../active-transcript-state.svelte';
import { AssistantMessage } from '$shared/chat-types';

function scrollState<T extends Partial<ConversationScrollState>>(
	overrides: T,
): T & ConversationScrollState {
	const complete = {
		completeInitialMessagesReveal: vi.fn(),
		displayMessageCount: 0,
		generationId: 'generation-1',
		hasInitialMessagesToReveal: false,
		hasMoreMessages: false,
		isLoadingMessages: false,
		isUserScrolledUp: false,
		loadAllMessages: vi.fn(async () => undefined),
		loadMoreMessages: vi.fn(async () => false),
		loadStatus: 'loaded' as const,
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

	it('preserves the viewport anchor after older messages render', async () => {
		const scroller = { scrollTop: 40, scrollHeight: 800, clientHeight: 400 } as HTMLDivElement;
		const chatState = {
			isUserScrolledUp: true,
			loadMoreMessages: vi.fn(async () => {
				Object.defineProperty(scroller, 'scrollHeight', { value: 1100, configurable: true });
				return true;
			}),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(false);
		await controller.loadMoreMessagesPreservingAnchor('chat-1', 800, 40);

		expect(chatState.loadMoreMessages).toHaveBeenCalledWith('chat-1');
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
			loadMoreMessages: vi.fn(async () => {
				scrollHeight = 1_100;
				return true;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(true);

		expect(await controller.loadMoreMessagesForNavigator('chat-1')).toBe(true);

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
			isUserScrolledUp: true,
			loadMoreMessages: vi.fn(async () => {
				scrollHeight = 1_050;
				return true;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(false);

		expect(await controller.loadMoreMessagesForNavigator('chat-1')).toBe(true);

		expect(scroller.scrollTop).toBe(410);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('does not restore navigator pagination after a newer scroll-to-top operation', async () => {
		let scrollHeight = 800;
		let resolveLoad!: (loaded: boolean) => void;
		const load = new Promise<boolean>((resolve) => {
			resolveLoad = resolve;
		});
		const scroller = { scrollTop: 160, clientHeight: 400 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			hasMoreMessages: false,
			isUserScrolledUp: true,
			loadMoreMessages: vi.fn(() => load),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});
		controller.setPinnedToBottom(false);

		const pagination = controller.loadMoreMessagesForNavigator('chat-1');
		await controller.scrollToTop();
		scrollHeight = 1_100;
		resolveLoad(true);

		expect(await pagination).toBe(false);
		expect(scroller.scrollTop).toBe(0);
	});

	it('centers a generation-scoped message row inside the active feed', async () => {
		const scroller = { scrollTop: 200, scrollHeight: 1_200, clientHeight: 400 } as HTMLDivElement;
		const content = document.createElement('div');
		const row = document.createElement('div');
		row.dataset.chatRowId = 'generation-1:7';
		row.scrollIntoView = vi.fn(() => {
			scroller.scrollTop = 300;
		});
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

		expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
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
			hasMoreMessages: false,
			isUserScrolledUp: false,
			loadAllMessages: vi.fn(),
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
	});

	it('completes the retained reveal before scrolling to top without pagination', async () => {
		const scroller = { scrollTop: 800, scrollHeight: 1200, clientHeight: 400 } as HTMLDivElement;
		const chatState = {
			hasInitialMessagesToReveal: true,
			hasMoreMessages: false,
			isUserScrolledUp: true,
			completeInitialMessagesReveal: vi.fn(() => {
				chatState.hasInitialMessagesToReveal = false;
			}),
			loadAllMessages: vi.fn(async () => undefined),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		await controller.scrollToTop();

		expect(chatState.completeInitialMessagesReveal).toHaveBeenCalledOnce();
		expect(chatState.loadAllMessages).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(0);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('keeps all previously exposed history when scrolling to the true transcript top', async () => {
		const chatState = new ActiveTranscriptState();
		chatState.replaceGeneration(
			'chat-1',
			'generation-1',
			Array.from({ length: 175 }, (_, index) => ({
				seq: index + 1,
				message: new AssistantMessage(
					'2026-07-01T00:00:00.000Z',
					`message-${index + 1}`,
				),
			})),
			{ lastSeq: 175, pageOldestSeq: 1, hasMore: false },
		);
		chatState.loadEarlierMessages();
		const scroller = { scrollTop: 800, scrollHeight: 1600, clientHeight: 400 } as HTMLDivElement;
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState,
			sessions: { selectedChatId: 'chat-1' },
		});

		expect(chatState.visibleRows[0]).toMatchObject({ kind: 'message', seq: 1 });

		await controller.scrollToTop();

		expect(scroller.scrollTop).toBe(0);
		expect(chatState.visibleRows).toHaveLength(175);
		expect(chatState.visibleRows[0]).toMatchObject({ kind: 'message', seq: 1 });
	});

	it('does not snap to bottom from an untagged scroll event', () => {
		const scroller = { scrollTop: 500, scrollHeight: 1200, clientHeight: 400 } as HTMLDivElement;
		const chatState = {
			isUserScrolledUp: false,
			hasMoreMessages: false,
			loadMoreMessages: vi.fn(),
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
			hasMoreMessages: false,
			loadMoreMessages: vi.fn(),
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
			hasMoreMessages: false,
			loadMoreMessages: vi.fn(),
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

	it('completes the initial reveal and paginates from one top-scroll event', async () => {
		let scrollHeight = 800;
		const scroller = { scrollTop: 40, clientHeight: 400 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			hasInitialMessagesToReveal: true,
			hasMoreMessages: true,
			isUserScrolledUp: true,
			completeInitialMessagesReveal: vi.fn(() => {
				chatState.hasInitialMessagesToReveal = false;
				scrollHeight = 1200;
			}),
			loadMoreMessages: vi.fn(async () => {
				scrollHeight = 1500;
				return true;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(false);
		controller.handleScroll();
		await vi.waitFor(() => expect(chatState.loadMoreMessages).toHaveBeenCalledOnce());

		expect(chatState.completeInitialMessagesReveal).toHaveBeenCalledOnce();
		expect(chatState.loadMoreMessages).toHaveBeenCalledWith('chat-1');
		expect(scroller.scrollTop).toBe(740);
		expect(chatState.isUserScrolledUp).toBe(true);
		expect(controller.isPinnedToBottom).toBe(false);
	});

	it('does not restore a stale pagination anchor over a scroll-to-top request', async () => {
		let scrollHeight = 800;
		let resolveLoad!: (loaded: boolean) => void;
		const pageLoad = new Promise<boolean>((resolve) => {
			resolveLoad = resolve;
		});
		const scroller = { scrollTop: 40, clientHeight: 400 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			hasInitialMessagesToReveal: true,
			hasMoreMessages: true,
			isUserScrolledUp: true,
			completeInitialMessagesReveal: vi.fn(() => {
				chatState.hasInitialMessagesToReveal = false;
				scrollHeight = 1200;
			}),
			loadMoreMessages: vi.fn(() => pageLoad),
			loadAllMessages: vi.fn(async () => {
				await pageLoad;
				chatState.hasMoreMessages = false;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.setPinnedToBottom(false);
		controller.handleScroll();
		await vi.waitFor(() => expect(chatState.loadMoreMessages).toHaveBeenCalledOnce());
		const scrollToTop = controller.scrollToTop();
		await vi.waitFor(() => expect(chatState.loadAllMessages).toHaveBeenCalledOnce());

		scrollHeight = 1500;
		resolveLoad(true);
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
			isUserScrolledUp: true,
			loadMoreMessages: vi.fn(async () => {
				sessions.selectedChatId = 'chat-2';
				Object.defineProperty(scroller, 'scrollHeight', { value: 1100, configurable: true });
				return true;
			}),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions,
		});

		await controller.loadMoreMessagesPreservingAnchor('chat-1', 800, 40);

		expect(scroller.scrollTop).toBe(40);
		expect(chatState.loadMoreMessages).toHaveBeenCalledWith('chat-1');
	});

	it('loads older messages until an initially underfilled viewport can scroll', async () => {
		let scrollHeight = 300;
		const scroller = { scrollTop: 0, clientHeight: 500 } as HTMLDivElement;
		Object.defineProperty(scroller, 'scrollHeight', {
			get: () => scrollHeight,
			configurable: true,
		});
		const chatState = {
			hasMoreMessages: true,
			isUserScrolledUp: false,
			loadMoreMessages: vi.fn(async () => {
				scrollHeight = scrollHeight === 300 ? 450 : 800;
				return true;
			}),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		await controller.fillUnderfilledViewport();

		expect(chatState.loadMoreMessages).toHaveBeenCalledTimes(2);
		expect(chatState.loadMoreMessages).toHaveBeenCalledWith('chat-1');
		expect(scroller.scrollTop).toBe(800);
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
			hasInitialMessagesToReveal: true,
			hasMoreMessages: true,
			isUserScrolledUp: false,
			loadMoreMessages: vi.fn(async () => {
				scrollHeight = 800;
				return true;
			}),
		};
		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions: { selectedChatId: 'chat-1' },
		});

		await controller.fillUnderfilledViewport();

		expect(chatState.loadMoreMessages).not.toHaveBeenCalled();

		chatState.hasInitialMessagesToReveal = false;
		await controller.fillUnderfilledViewport();

		expect(chatState.loadMoreMessages).toHaveBeenCalledOnce();
		expect(chatState.loadMoreMessages).toHaveBeenCalledWith('chat-1');
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
			hasMoreMessages: true,
			isUserScrolledUp: false,
			loadMoreMessages: vi.fn(async () => {
				scrollHeight = 800;
				sessions.selectedChatId = 'chat-2';
				return true;
			}),
		};

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: scrollState(chatState),
			sessions,
		});

		await controller.fillUnderfilledViewport();

		expect(chatState.loadMoreMessages).toHaveBeenCalledTimes(1);
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
			chatState: scrollState({ isUserScrolledUp: false, hasMoreMessages: true }),
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
			chatState: scrollState({ isUserScrolledUp: false, hasMoreMessages: false }),
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
			chatState: scrollState({ isUserScrolledUp: true, hasMoreMessages: false }),
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
			hasMoreMessages: false,
			loadMoreMessages: vi.fn(),
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

	it('does not restore bottom when the user was scrolled up before hiding the viewport', () => {
		const scroller = { scrollTop: 120, scrollHeight: 1000, clientHeight: 600 } as HTMLDivElement;
		const chatState = {
			isUserScrolledUp: true,
			hasMoreMessages: false,
			loadMoreMessages: vi.fn(),
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
			hasMoreMessages: true,
			loadMoreMessages: vi.fn(),
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
		expect(chatState.loadMoreMessages).not.toHaveBeenCalled();
	});
});
