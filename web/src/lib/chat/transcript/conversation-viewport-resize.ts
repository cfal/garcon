export function observeConversationViewportResize(
	host: HTMLElement | null,
	shouldScrollToEnd: () => boolean,
	scrollToEnd: () => void,
): (() => void) | undefined {
	if (!host || typeof ResizeObserver === 'undefined') return undefined;
	let previousHeight = host.clientHeight;
	const observer = new ResizeObserver((entries) => {
		const nextHeight = entries[0]?.contentRect.height ?? host.clientHeight;
		if (nextHeight <= 0 || nextHeight === previousHeight) return;
		previousHeight = nextHeight;
		if (shouldScrollToEnd()) scrollToEnd();
	});
	observer.observe(host);
	return () => observer.disconnect();
}
