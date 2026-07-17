interface VisibilityPollingDocument {
	visibilityState: DocumentVisibilityState;
	addEventListener: Document['addEventListener'];
	removeEventListener: Document['removeEventListener'];
}

export interface VisibilityPollingOptions {
	intervalMs: number;
	poll: () => void;
	pollImmediately?: boolean;
	documentRef?: VisibilityPollingDocument;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
	queueMicrotaskFn?: typeof queueMicrotask;
}

export function canPollVisibility(
	documentRef: Pick<VisibilityPollingDocument, 'visibilityState'> | undefined = globalThis.document,
): boolean {
	return !documentRef || documentRef.visibilityState === 'visible';
}

export function startVisibilityPolling({
	intervalMs,
	poll,
	pollImmediately = false,
	documentRef = globalThis.document,
	setIntervalFn = globalThis.setInterval,
	clearIntervalFn = globalThis.clearInterval,
	queueMicrotaskFn = globalThis.queueMicrotask,
}: VisibilityPollingOptions): () => void {
	let active = true;
	function tick(): void {
		if (!active || !canPollVisibility(documentRef)) return;
		poll();
	}

	if (pollImmediately) queueMicrotaskFn(tick);
	const intervalId = setIntervalFn(tick, intervalMs);
	documentRef?.addEventListener('visibilitychange', tick);

	return () => {
		active = false;
		clearIntervalFn(intervalId);
		documentRef?.removeEventListener('visibilitychange', tick);
	};
}
