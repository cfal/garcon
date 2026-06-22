// Scroll viewport controller for the chat conversation pane. Manages
// near-bottom detection, pinned-to-bottom state, infinite scroll
// loading, and layout resize reconciliation.

import { tick } from 'svelte';
import { reconcileScrollAfterHeightDelta } from '$lib/chat/scroll-anchor';
import type { ChatState } from '$lib/chat/state.svelte';

export interface ScrollControllerDeps {
	getScrollContainer: () => HTMLDivElement | null;
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
	#visibilityFrame: number | null = null;

	constructor(private deps: ScrollControllerDeps) {}

	isNearBottom(): boolean {
		const node = this.deps.getScrollContainer();
		if (!node) return false;
		const { scrollTop, scrollHeight, clientHeight } = node;
		return scrollHeight - scrollTop - clientHeight < 50;
	}

	scrollToBottom(): void {
		const node = this.deps.getScrollContainer();
		if (!node) return;
		node.scrollTop = node.scrollHeight;
		this.deps.chatState.isUserScrolledUp = false;
		this.isPinnedToBottom = true;
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
			if (node) node.scrollTop = 0;
		} finally {
			this.isScrollingToTop = false;
		}
	}

	handleScroll(): void {
		const node = this.deps.getScrollContainer();
		if (!node || !this.#isViewportVisible || node.clientHeight <= 0) return;
		const nearBottom = this.isNearBottom();
		this.deps.chatState.isUserScrolledUp = !nearBottom;
		this.isPinnedToBottom = nearBottom;

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
		container.scrollTop = prevTop + (newHeight - prevHeight);
		this.deps.chatState.isUserScrolledUp = true;
		this.isPinnedToBottom = false;
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
				this.scrollToBottom();
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
			reconcileScrollAfterHeightDelta(delta, pinned, scroller, () => {
				requestAnimationFrame(() => this.scrollToBottom());
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
			if (pinned) {
				requestAnimationFrame(() => {
					this.scrollToBottom();
					void this.fillUnderfilledViewport();
				});
			}
			previousHeight = nextHeight;
		});
		observer.observe(scroller);
		return () => observer.disconnect();
	}

	setViewportVisible(isVisible: boolean): void {
		if (isVisible === this.#isViewportVisible) return;
		this.#isViewportVisible = isVisible;

		if (!isVisible) {
			this.#restoreBottomOnNextVisible = this.#shouldRestoreBottomAfterHidden();
			this.#cancelVisibilityFrame();
			return;
		}

		if (!this.#restoreBottomOnNextVisible) return;
		this.#restoreBottomOnNextVisible = false;
		this.#scheduleBottomRestore();
	}

	#shouldRestoreBottomAfterHidden(): boolean {
		const node = this.deps.getScrollContainer();
		const stateSaysPinned = this.isPinnedToBottom || !this.deps.chatState.isUserScrolledUp;
		if (!node || node.clientHeight <= 0) return stateSaysPinned;
		return stateSaysPinned || this.isNearBottom();
	}

	#scheduleBottomRestore(): void {
		this.#cancelVisibilityFrame();
		this.#visibilityFrame = requestAnimationFrame(() => {
			this.#visibilityFrame = null;
			if (!this.#isViewportVisible) return;
			const node = this.deps.getScrollContainer();
			if (!node || node.clientHeight <= 0) return;
			this.scrollToBottom();
			void this.fillUnderfilledViewport();
		});
	}

	#cancelVisibilityFrame(): void {
		if (this.#visibilityFrame === null) return;
		cancelAnimationFrame(this.#visibilityFrame);
		this.#visibilityFrame = null;
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
				const half = scrollContainer.clientHeight / 2;
				scrollContainer.scrollBy({
					top: event.key === 'd' ? half : -half,
					behavior: 'instant',
				});
			}
		}
	}
}
