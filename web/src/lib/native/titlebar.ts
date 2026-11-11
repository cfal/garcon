export interface NativeTitlebarSnapshot {
	readonly hidden: boolean;
	readonly failed: boolean;
}

export interface NativeTitlebar {
	requestHidden(hidden: boolean): void;
	subscribe(listener: (snapshot: NativeTitlebarSnapshot) => void): () => void;
}

export function getNativeTitlebar(): NativeTitlebar | null {
	if (typeof window === 'undefined') return null;
	const host = window.__GARCON_NATIVE__;
	const titlebar = host?.titlebar;
	if (
		host?.version !== 1 ||
		typeof titlebar?.requestHidden !== 'function' ||
		typeof titlebar.subscribe !== 'function'
	)
		return null;
	return {
		requestHidden: (hidden) => titlebar.requestHidden(hidden),
		subscribe: (listener) => titlebar.subscribe(listener),
	};
}
