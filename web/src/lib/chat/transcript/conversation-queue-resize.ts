import type { ConversationViewportPort } from './conversation-viewport-port.js';

export function observeConversationQueueResize(
	host: HTMLElement | null | undefined,
	shouldAdjustPosition: () => boolean,
	getViewport: () => ConversationViewportPort | null,
	isPinnedToBottom: () => boolean,
	scrollToBottom: () => void,
): (() => void) | undefined {
	if (!host || typeof ResizeObserver === 'undefined') return undefined;
	let previousHeight = host.offsetHeight;
	const observer = new ResizeObserver((entries) => {
		const nextHeight = entries[0]?.contentRect.height ?? host.offsetHeight;
		const delta = nextHeight - previousHeight;
		previousHeight = nextHeight;
		if (!shouldAdjustPosition() || delta === 0) return;
		const viewport = getViewport();
		if (!viewport) return;
		if (isPinnedToBottom()) scrollToBottom();
		else viewport.scrollBy(delta);
	});
	observer.observe(host);
	return () => observer.disconnect();
}
