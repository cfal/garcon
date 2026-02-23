// Scroll viewport controller for the chat conversation pane. Manages
// near-bottom detection, pinned-to-bottom state, infinite scroll
// loading, and queue controls resize reconciliation.

import { reconcileScrollAfterHeightDelta } from '$lib/chat/scroll-anchor';
import type { ChatState } from '$lib/chat/state.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';

export interface ScrollControllerDeps {
	getScrollContainer: () => HTMLDivElement | undefined;
	getQueueContainer: () => HTMLDivElement | undefined;
	chatState: ChatState;
	sessions: { selectedChatId: string | null };
	ws: WsConnection;
}

export class ConversationScrollController {
	isPinnedToBottom = $state(true);

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

	handleScroll(): void {
		const node = this.deps.getScrollContainer();
		if (!node) return;
		const nearBottom = this.isNearBottom();
		this.deps.chatState.isUserScrolledUp = !nearBottom;
		this.isPinnedToBottom = nearBottom;

		if (node.scrollTop < 100 && this.deps.chatState.hasMoreMessages) {
			const chatId = this.deps.sessions.selectedChatId;
			if (chatId) {
				const prevHeight = node.scrollHeight;
				const prevTop = node.scrollTop;
				this.deps.chatState.loadMoreMessages(chatId, this.deps.ws).then((loaded) => {
					const container = this.deps.getScrollContainer();
					if (loaded && container) {
						const newHeight = container.scrollHeight;
						container.scrollTop = prevTop + (newHeight - prevHeight);
					}
				});
			}
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
					behavior: 'smooth',
				});
			}
		}
	}
}
