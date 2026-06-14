import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationScrollController } from '../conversation-scroll-controller.svelte';

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

	beforeEach(() => {
		ResizeObserverStub.instances = [];
		globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
		globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
			cb(0);
			return 1;
		}) as typeof requestAnimationFrame;
	});

	afterEach(() => {
		globalThis.ResizeObserver = originalResizeObserver;
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	});

	it('keeps the viewport pinned to bottom when the queue controls height changes', () => {
		const scrollToBottom = vi.spyOn(ConversationScrollController.prototype, 'scrollToBottom');
		const scroller = { scrollTop: 120, scrollHeight: 640, clientHeight: 520 } as HTMLDivElement;
		const queue = { offsetHeight: 200 } as HTMLDivElement;

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => queue,
			chatState: { isUserScrolledUp: false } as never,
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.isPinnedToBottom = true;
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
			chatState: { isUserScrolledUp: true } as never,
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.isPinnedToBottom = false;
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
			chatState: chatState as never,
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.isPinnedToBottom = false;
		await controller.loadMoreMessagesPreservingAnchor('chat-1', 800, 40);

		expect(chatState.loadMoreMessages).toHaveBeenCalledWith('chat-1');
		expect(scroller.scrollTop).toBe(340);
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
			chatState: chatState as never,
			sessions,
		});

		await controller.loadMoreMessagesPreservingAnchor('chat-1', 800, 40);

		expect(scroller.scrollTop).toBe(40);
		expect(chatState.loadMoreMessages).toHaveBeenCalledWith('chat-1');
	});

	it('keeps the viewport pinned to bottom when the scroll container height changes', () => {
		const scrollToBottom = vi.spyOn(ConversationScrollController.prototype, 'scrollToBottom');
		const scroller = { scrollTop: 120, scrollHeight: 800, clientHeight: 520 } as HTMLDivElement;

		const controller = new ConversationScrollController({
			getScrollContainer: () => scroller,
			getQueueContainer: () => undefined,
			chatState: { isUserScrolledUp: false } as never,
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.isPinnedToBottom = true;
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
			chatState: { isUserScrolledUp: true } as never,
			sessions: { selectedChatId: 'chat-1' },
		});

		controller.isPinnedToBottom = false;
		const cleanup = controller.observeScrollContainerResize();

		ResizeObserverStub.instances[0]?.emit(360);

		expect(scrollToBottom).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(120);
		cleanup?.();
		scrollToBottom.mockRestore();
	});
});
