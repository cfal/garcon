export interface VirtualListEnvironment {
	now(): number;
	queueMicrotask(callback: () => void): void;
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(handle: number): void;
	requestAnimationFrame(callback: FrameRequestCallback): number;
	cancelAnimationFrame(handle: number): void;
	createResizeObserver(callback: ResizeObserverCallback): ResizeObserver;
}

export const browserVirtualListEnvironment: Readonly<VirtualListEnvironment> = Object.freeze({
	now: () => performance.now(),
	queueMicrotask: (callback: () => void) => queueMicrotask(callback),
	setTimeout: (callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs),
	clearTimeout: (handle: number) => window.clearTimeout(handle),
	requestAnimationFrame: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
	cancelAnimationFrame: (handle: number) => cancelAnimationFrame(handle),
	createResizeObserver: (callback: ResizeObserverCallback) => new ResizeObserver(callback),
});
