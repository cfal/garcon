import type { NativeTitlebar } from './titlebar';

export interface NativeServerChooser {
	requestServerChooser(): void;
}

interface NativeHost extends NativeServerChooser {
	readonly version: 1;
	readonly titlebar?: NativeTitlebar;
}

declare global {
	interface Window {
		__GARCON_NATIVE__?: NativeHost;
	}
}

// Capability discovery is a UI hint. The host authorizes every request independently.
export function getNativeServerChooser(): NativeServerChooser | null {
	if (typeof window === 'undefined') return null;
	const host = window.__GARCON_NATIVE__;
	if (host?.version !== 1 || typeof host.requestServerChooser !== 'function') return null;
	return { requestServerChooser: () => host.requestServerChooser() };
}
