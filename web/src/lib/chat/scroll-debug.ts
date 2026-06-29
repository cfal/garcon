const STORAGE_KEY = 'garcon.debug.chatScroll';
const QUERY_PARAM = 'debugChatScroll';

export interface ChatScrollMetrics {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	bottomGap: number;
	bottomAnchorGap?: number;
}

export function getChatScrollMetrics(node: HTMLDivElement | null): ChatScrollMetrics | null {
	if (!node) return null;
	const { scrollTop, scrollHeight, clientHeight } = node;
	const metrics: ChatScrollMetrics = {
		scrollTop,
		scrollHeight,
		clientHeight,
		bottomGap: scrollHeight - clientHeight - scrollTop,
	};
	if (typeof node.querySelector === 'function' && typeof node.getBoundingClientRect === 'function') {
		const anchor = node.querySelector('[data-chat-bottom-anchor]');
		if (typeof HTMLElement !== 'undefined' && anchor instanceof HTMLElement) {
			const viewportRect = node.getBoundingClientRect();
			const anchorRect = anchor.getBoundingClientRect();
			metrics.bottomAnchorGap = viewportRect.bottom - anchorRect.bottom;
		}
	}
	return metrics;
}

export function isChatScrollDebugEnabled(): boolean {
	if (typeof window === 'undefined') return false;
	if (import.meta.env.MODE === 'test') return false;
	try {
		const setting = window.localStorage.getItem(STORAGE_KEY);
		if (setting === '0') return false;
		if (setting === '1') return true;
		if (new URLSearchParams(window.location.search).has(QUERY_PARAM)) return true;
		return true;
	} catch {
		return true;
	}
}

export function debugChatScroll(label: string, details: Record<string, unknown> = {}): void {
	if (!isChatScrollDebugEnabled()) return;
	const at = typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now();
	console.log('[chat-scroll]', label, JSON.stringify({ at, ...details }));
}
