export interface NativeLifecycle {
	requestReload(): void;
	reportReady(): void;
}

export function getNativeLifecycle(): NativeLifecycle | null {
	if (typeof window === 'undefined') return null;
	const host = window.__GARCON_NATIVE__;
	const lifecycle = host?.lifecycle;
	if (
		host?.version !== 1 ||
		typeof lifecycle?.requestReload !== 'function' ||
		typeof lifecycle.reportReady !== 'function'
	)
		return null;
	return {
		requestReload: () => lifecycle.requestReload(),
		reportReady: () => lifecycle.reportReady(),
	};
}
