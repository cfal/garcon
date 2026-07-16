export interface InitialTranscriptRevealScheduler {
	requestAnimationFrame(callback: FrameRequestCallback): number;
	cancelAnimationFrame(handle: number): void;
	requestIdleCallback?(callback: IdleRequestCallback, options?: IdleRequestOptions): number;
	cancelIdleCallback?(handle: number): void;
	setTimeout(handler: TimerHandler, timeout?: number): number;
	clearTimeout(handle: number): void;
}

export function scheduleInitialTranscriptReveal(
	reveal: () => boolean | void,
	scheduler: InitialTranscriptRevealScheduler = window,
): () => void {
	let cancelled = false;
	let frameId: number | null = null;
	let idleId: number | null = null;
	let timeoutId: number | null = null;

	const runReveal = () => {
		if (cancelled) return;
		if (reveal()) scheduleReveal();
	};
	const scheduleReveal = () => {
		if (cancelled) return;
		if (scheduler.requestIdleCallback) {
			idleId = scheduler.requestIdleCallback(runReveal, { timeout: 100 });
			return;
		}
		timeoutId = scheduler.setTimeout(runReveal, 16);
	};

	// Two frames ensure the small initial transcript batch reaches a paint
	// before the browser starts creating the remaining cached messages.
	frameId = scheduler.requestAnimationFrame(() => {
		frameId = scheduler.requestAnimationFrame(scheduleReveal);
	});

	return () => {
		cancelled = true;
		if (frameId !== null) scheduler.cancelAnimationFrame(frameId);
		if (idleId !== null) scheduler.cancelIdleCallback?.(idleId);
		if (timeoutId !== null) scheduler.clearTimeout(timeoutId);
	};
}
