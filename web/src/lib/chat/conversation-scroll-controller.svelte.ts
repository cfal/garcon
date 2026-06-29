// Scroll viewport controller for the chat conversation pane. Manages
// near-bottom detection, pinned-to-bottom state, infinite scroll
// loading, and layout resize reconciliation.

import { tick } from 'svelte';
import { reconcileScrollAfterHeightDelta } from '$lib/chat/scroll-anchor';
import { debugChatScroll, getChatScrollMetrics } from '$lib/chat/scroll-debug';
import type { ChatState } from '$lib/chat/state.svelte';

const USER_SCROLL_INTENT_WINDOW_MS = 2_000;

export interface ScrollControllerDeps {
	getScrollContainer: () => HTMLDivElement | null;
	getScrollContentContainer?: () => HTMLDivElement | null;
	getQueueContainer: () => HTMLDivElement | undefined;
	chatState: ChatState;
	sessions: { selectedChatId: string | null };
}

export class ConversationScrollController {
	isPinnedToBottom = $state(true);
	isScrollingToTop = $state(false);
	#isAutoFillingViewport = false;
	#isViewportVisible = true;
	#restoreBottomOnNextVisible = false;
	#bottomRestoreFrame: number | null = null;
	#lastUserScrollIntentAt = 0;

	constructor(private deps: ScrollControllerDeps) {}

	isNearBottom(): boolean {
		const node = this.deps.getScrollContainer();
		if (!node) return false;
		const { scrollTop, scrollHeight, clientHeight } = node;
		return scrollHeight - scrollTop - clientHeight < 50;
	}

	scrollToBottom(reason = 'direct'): void {
		const node = this.deps.getScrollContainer();
		if (!node) return;
		const before = getChatScrollMetrics(node);
		node.scrollTop = node.scrollHeight;
		this.deps.chatState.isUserScrolledUp = false;
		this.setPinnedToBottom(true);
		debugChatScroll('scrollToBottom', {
			reason,
			before,
			after: getChatScrollMetrics(node),
			chatId: this.deps.sessions.selectedChatId,
		});
	}

	setPinnedToBottom(isPinned: boolean): void {
		this.isPinnedToBottom = isPinned;
		if (isPinned) this.#lastUserScrollIntentAt = 0;
	}

	noteUserScrollIntent(): void {
		this.#lastUserScrollIntentAt = performance.now();
		debugChatScroll('user-scroll-intent', {
			metrics: getChatScrollMetrics(this.deps.getScrollContainer()),
			chatId: this.deps.sessions.selectedChatId,
		});
	}

	/** Loads all paginated messages and scrolls to the very top instantly. */
	async scrollToTop(): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId) return;

		this.isScrollingToTop = true;
		try {
			if (this.deps.chatState.hasMoreMessages) {
				await this.deps.chatState.loadAllMessages(chatId);
			}
			const node = this.deps.getScrollContainer();
			if (node) {
				this.noteUserScrollIntent();
				node.scrollTop = 0;
				this.deps.chatState.isUserScrolledUp = true;
				this.setPinnedToBottom(false);
			}
		} finally {
			this.isScrollingToTop = false;
		}
	}

	handleScroll(): void {
		const node = this.deps.getScrollContainer();
		if (!node || !this.#isViewportVisible || node.clientHeight <= 0) return;
		const nearBottom = this.isNearBottom();
		const metrics = getChatScrollMetrics(node);
		const shouldRemainPinned =
			!nearBottom &&
			!this.#hasRecentUserScrollIntent() &&
			(this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp);
		if (shouldRemainPinned) {
			// Layout growth can dispatch a scroll event while a conversation is
			// pinned. Resize observers own the actual bottom repair; the scroll
			// event must not snap a possible user scroll back to the bottom.
			debugChatScroll('scroll-event-ignored-while-pinned', {
				metrics,
				chatId: this.deps.sessions.selectedChatId,
			});
			return;
		}
		this.deps.chatState.isUserScrolledUp = !nearBottom;
		this.setPinnedToBottom(nearBottom);
		debugChatScroll('scroll-event', {
			nearBottom,
			metrics,
			isUserScrolledUp: this.deps.chatState.isUserScrolledUp,
			isPinnedToBottom: this.isPinnedToBottom,
			chatId: this.deps.sessions.selectedChatId,
		});

		if (node.scrollTop < 100 && this.deps.chatState.hasMoreMessages) {
			const chatId = this.deps.sessions.selectedChatId;
			if (chatId) {
				void this.loadMoreMessagesPreservingAnchor(chatId, node.scrollHeight, node.scrollTop);
			}
		}
	}

	async loadMoreMessagesPreservingAnchor(
		chatId: string,
		prevHeight: number,
		prevTop: number,
	): Promise<void> {
		const loaded = await this.deps.chatState.loadMoreMessages(chatId);
		if (!loaded) return;
		if (this.deps.sessions.selectedChatId !== chatId) return;

		await tick();
		if (this.deps.sessions.selectedChatId !== chatId) return;

		const container = this.deps.getScrollContainer();
		if (!container) return;

		const newHeight = container.scrollHeight;
		const before = getChatScrollMetrics(container);
		container.scrollTop = prevTop + (newHeight - prevHeight);
		this.deps.chatState.isUserScrolledUp = true;
		this.setPinnedToBottom(false);
		debugChatScroll('older-messages-anchor-restored', {
			prevHeight,
			prevTop,
			newHeight,
			before,
			after: getChatScrollMetrics(container),
			chatId,
		});
	}

	async fillUnderfilledViewport(): Promise<void> {
		const chatId = this.deps.sessions.selectedChatId;
		if (!chatId || !this.#isViewportVisible || this.#isAutoFillingViewport) return;

		this.#isAutoFillingViewport = true;
		try {
			while (this.deps.sessions.selectedChatId === chatId && this.deps.chatState.hasMoreMessages) {
				await tick();
				const container = this.deps.getScrollContainer();
				if (!container) return;
				if (container.scrollHeight > container.clientHeight + 1) return;

				const previousHeight = container.scrollHeight;
				const loaded = await this.deps.chatState.loadMoreMessages(chatId);
				if (!loaded || this.deps.sessions.selectedChatId !== chatId) return;

				await tick();
				const updated = this.deps.getScrollContainer();
				if (!updated) return;
				this.scrollToBottom('underfilled-viewport-fill');
				if (updated.scrollHeight <= previousHeight) return;
			}
		} finally {
			this.#isAutoFillingViewport = false;
		}
	}

	// Creates a ResizeObserver for the queue controls container that
	// reconciles scroll position when the queue panel height changes.
	// Returns a cleanup function to disconnect the observer.
	observeQueueResize(): (() => void) | undefined {
		const host = this.deps.getQueueContainer();
		const scroller = this.deps.getScrollContainer();
		if (!host || !scroller || typeof ResizeObserver === 'undefined') return undefined;

		let previousHeight = host.offsetHeight;
		const observer = new ResizeObserver((entries) => {
			const nextHeight = entries[0]?.contentRect.height ?? host.offsetHeight;
			if (!this.#isViewportVisible || scroller.clientHeight <= 0) {
				previousHeight = nextHeight;
				return;
			}
			const delta = nextHeight - previousHeight;
			const pinned = this.isPinnedToBottom || this.isNearBottom();
			debugChatScroll('queue-resize', {
				previousHeight,
				nextHeight,
				delta,
				pinned,
				before: getChatScrollMetrics(scroller),
				chatId: this.deps.sessions.selectedChatId,
			});
			reconcileScrollAfterHeightDelta(delta, pinned, scroller, () => {
				this.#restoreBottomNow('queue-resize-pinned');
			});
			debugChatScroll('queue-resize-reconciled', {
				after: getChatScrollMetrics(scroller),
				chatId: this.deps.sessions.selectedChatId,
			});
			previousHeight = nextHeight;
		});
		observer.observe(host);
		return () => observer.disconnect();
	}

	// Keeps pinned conversations at the bottom when the viewport height
	// changes, for example when the mobile keyboard opens or closes.
	observeScrollContainerResize(): (() => void) | undefined {
		const scroller = this.deps.getScrollContainer();
		if (!scroller || typeof ResizeObserver === 'undefined') return undefined;

		let previousHeight = scroller.clientHeight;
		const observer = new ResizeObserver((entries) => {
			const nextHeight = entries[0]?.contentRect.height ?? scroller.clientHeight;
			if (nextHeight <= 0 || nextHeight === previousHeight) return;
			const pinned = this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp;
			debugChatScroll('scroll-container-resize', {
				previousHeight,
				nextHeight,
				pinned,
				metrics: getChatScrollMetrics(scroller),
				chatId: this.deps.sessions.selectedChatId,
			});
			if (pinned) {
				this.#restoreBottomNow('scroll-container-resize');
			}
			previousHeight = nextHeight;
		});
		observer.observe(scroller);
		return () => observer.disconnect();
	}

	// Keeps pinned conversations at the bottom when transcript content
	// finishes rendering after the initial message load.
	observeScrollContentResize(): (() => void) | undefined {
		const content = this.deps.getScrollContentContainer?.();
		const scroller = this.deps.getScrollContainer();
		if (!content || !scroller || typeof ResizeObserver === 'undefined') return undefined;

		let previousHeight = content.offsetHeight;
		const observer = new ResizeObserver((entries) => {
			const nextHeight = entries[0]?.contentRect.height ?? content.offsetHeight;
			if (nextHeight <= 0 || nextHeight === previousHeight) return;
			previousHeight = nextHeight;
			const pinned = this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp;
			debugChatScroll('scroll-content-resize', {
				nextHeight,
				pinned,
				metrics: getChatScrollMetrics(scroller),
				chatId: this.deps.sessions.selectedChatId,
			});
			if (!this.#isViewportVisible || scroller.clientHeight <= 0 || !pinned) return;
			this.#restoreBottomNow('scroll-content-resize');
		});
		observer.observe(content);
		return () => observer.disconnect();
	}

	setViewportVisible(isVisible: boolean): void {
		if (isVisible === this.#isViewportVisible) return;
		this.#isViewportVisible = isVisible;

		if (!isVisible) {
			this.#restoreBottomOnNextVisible = this.#shouldRestoreBottomAfterHidden();
			this.#cancelBottomRestoreFrame();
			return;
		}

		if (!this.#restoreBottomOnNextVisible) return;
		this.#restoreBottomOnNextVisible = false;
		this.#scheduleBottomRestore('viewport-visible');
	}

	#shouldRestoreBottomAfterHidden(): boolean {
		const node = this.deps.getScrollContainer();
		const stateSaysPinned = this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp;
		if (!node || node.clientHeight <= 0) return stateSaysPinned;
		return stateSaysPinned || this.isNearBottom();
	}

	#scheduleBottomRestore(reason: string): void {
		this.#cancelBottomRestoreFrame();
		debugChatScroll('schedule-bottom-restore', {
			reason,
			metrics: getChatScrollMetrics(this.deps.getScrollContainer()),
			chatId: this.deps.sessions.selectedChatId,
		});
		this.#bottomRestoreFrame = requestAnimationFrame(() => {
			this.#bottomRestoreFrame = null;
			this.#restoreBottomNow(reason);
		});
	}

	#restoreBottomNow(reason: string): void {
		this.#cancelBottomRestoreFrame();
		if (!this.#isViewportVisible) return;
		const node = this.deps.getScrollContainer();
		if (!node || node.clientHeight <= 0) return;
		this.scrollToBottom(reason);
		void this.fillUnderfilledViewport();
	}

	#cancelBottomRestoreFrame(): void {
		if (this.#bottomRestoreFrame === null) return;
		cancelAnimationFrame(this.#bottomRestoreFrame);
		this.#bottomRestoreFrame = null;
	}

	#hasRecentUserScrollIntent(): boolean {
		return (
			this.#lastUserScrollIntentAt > 0 &&
			performance.now() - this.#lastUserScrollIntentAt <= USER_SCROLL_INTENT_WINDOW_MS
		);
	}

	handleHalfPageScroll(event: KeyboardEvent): void {
		const scrollContainer = this.deps.getScrollContainer();
		if (!scrollContainer) return;

		if (event.ctrlKey && (event.key === 'u' || event.key === 'd')) {
			const active = document.activeElement;
			const inTextarea = active?.tagName === 'TEXTAREA';
			const inContainer = scrollContainer.contains(active) || active === scrollContainer;
			if (inTextarea || inContainer) {
				event.preventDefault();
				this.noteUserScrollIntent();
				const half = scrollContainer.clientHeight / 2;
				scrollContainer.scrollBy({
					top: event.key === 'd' ? half : -half,
					behavior: 'instant',
				});
			}
		}
	}
}
