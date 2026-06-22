import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	canPollGitFreshness,
	startGitFreshnessPolling,
} from '../git-freshness-polling';

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

describe('git freshness polling', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('polls on the configured interval without an immediate first tick', () => {
		vi.useFakeTimers();
		const checkFreshness = vi.fn();
		const documentRef = makeDocumentRef('visible');

		const cleanup = startGitFreshnessPolling({
			projectPath: '/project',
			checkFreshness,
			documentRef,
			intervalMs: 15_000,
		});

		expect(checkFreshness).not.toHaveBeenCalled();
		vi.advanceTimersByTime(14_999);
		expect(checkFreshness).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(checkFreshness).toHaveBeenCalledWith('/project');

		cleanup();
	});

	it('skips hidden intervals and checks once when the document becomes visible', () => {
		vi.useFakeTimers();
		const checkFreshness = vi.fn();
		const documentRef = makeDocumentRef('hidden');

		const cleanup = startGitFreshnessPolling({
			projectPath: '/project',
			checkFreshness,
			documentRef,
			intervalMs: 15_000,
		});

		vi.advanceTimersByTime(15_000);
		expect(checkFreshness).not.toHaveBeenCalled();

		documentRef.visibilityState = 'visible';
		documentRef.dispatch('visibilitychange');
		expect(checkFreshness).toHaveBeenCalledOnce();

		cleanup();
	});

	it('removes visibility listeners and intervals on cleanup', () => {
		vi.useFakeTimers();
		const checkFreshness = vi.fn();
		const documentRef = makeDocumentRef('visible');

		const cleanup = startGitFreshnessPolling({
			projectPath: '/project',
			checkFreshness,
			documentRef,
			intervalMs: 15_000,
		});
		cleanup();

		expect(documentRef.listeners.size).toBe(0);
		vi.advanceTimersByTime(15_000);
		expect(checkFreshness).not.toHaveBeenCalled();
	});

	it('reports polling availability from document visibility', () => {
		expect(canPollGitFreshness(makeDocumentRef('visible'))).toBe(true);
		expect(canPollGitFreshness(makeDocumentRef('hidden'))).toBe(false);
	});
});
