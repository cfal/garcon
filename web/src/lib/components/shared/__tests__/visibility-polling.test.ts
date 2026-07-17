import { afterEach, describe, expect, it, vi } from 'vitest';
import { startVisibilityPolling } from '../visibility-polling.js';

function makeDocumentRef(initialVisibility: DocumentVisibilityState) {
	const listeners = new Map<string, EventListener>();
	return {
		get visibilityState() {
			return initialVisibility;
		},
		set visibilityState(value: DocumentVisibilityState) {
			initialVisibility = value;
		},
		addEventListener: vi.fn((event: string, listener: EventListener) => {
			listeners.set(event, listener);
		}),
		removeEventListener: vi.fn((event: string, listener: EventListener) => {
			if (listeners.get(event) === listener) listeners.delete(event);
		}),
		dispatch(event: string) {
			listeners.get(event)?.(new Event(event));
		},
		listeners,
	};
}

describe('visibility polling', () => {
	afterEach(() => vi.useRealTimers());

	it('polls immediately, on visible intervals, and when visibility returns', async () => {
		vi.useFakeTimers();
		const poll = vi.fn();
		const documentRef = makeDocumentRef('visible');
		const cleanup = startVisibilityPolling({
			intervalMs: 15_000,
			poll,
			pollImmediately: true,
			documentRef,
		});

		await vi.runAllTicks();
		expect(poll).toHaveBeenCalledOnce();
		documentRef.visibilityState = 'hidden';
		vi.advanceTimersByTime(15_000);
		expect(poll).toHaveBeenCalledOnce();
		documentRef.visibilityState = 'visible';
		documentRef.dispatch('visibilitychange');
		expect(poll).toHaveBeenCalledTimes(2);
		cleanup();
	});

	it('cancels the queued immediate poll, interval, and listener on cleanup', async () => {
		vi.useFakeTimers();
		const poll = vi.fn();
		const documentRef = makeDocumentRef('visible');
		const cleanup = startVisibilityPolling({
			intervalMs: 15_000,
			poll,
			pollImmediately: true,
			documentRef,
		});

		cleanup();
		await vi.runAllTicks();
		vi.advanceTimersByTime(15_000);

		expect(poll).not.toHaveBeenCalled();
		expect(documentRef.listeners.size).toBe(0);
	});
});
