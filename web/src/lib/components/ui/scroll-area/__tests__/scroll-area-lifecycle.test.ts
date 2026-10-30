import { cleanup, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';
import ScrollAreaLifecycleTestHost from './ScrollAreaLifecycleTestHost.svelte';

describe('ScrollArea lifecycle', () => {
	let restoreResizeObserver: () => void;
	beforeAll(() => {
		restoreResizeObserver = installResizeObserverHarness();
	});
	afterAll(() => restoreResizeObserver());
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each(['scroll', 'auto'] as const)(
		'cancels pending debounce and thumb animation work on unmount in %s mode',
		async (type) => {
			const { container, unmount } = render(ScrollAreaLifecycleTestHost, { type });
			const viewport = container.querySelector<HTMLElement>('[data-scroll-area-viewport]')!;
			const content = viewport.firstElementChild!;
			Object.defineProperties(viewport, {
				offsetHeight: { configurable: true, value: 200 },
				offsetWidth: { configurable: true, value: 400 },
				scrollHeight: { configurable: true, value: 2_000 },
				scrollWidth: { configurable: true, value: 400 },
			});
			await waitFor(() => {
				expect(
					ResizeObserverHarness.instances.some((observer) => observer.observed.has(content)),
				).toBe(true);
			});
			ResizeObserverHarness.emit(content, 400, 2_000);
			await waitFor(() =>
				expect(container.querySelector('[data-scroll-area-thumb]')).not.toBeNull(),
			);
			await tick();

			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const timeouts = vi.spyOn(globalThis, 'setTimeout');
			const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
			const frames = new Map<number, FrameRequestCallback>();
			let nextFrame = 0;
			vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
				frames.set(++nextFrame, callback);
				return nextFrame;
			});
			vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
				frames.delete(id);
			});
			viewport.scrollTop = 100;
			viewport.dispatchEvent(new Event('scroll'));
			await tick();
			const debounceTimers = timeouts.mock.calls.flatMap(([, delay], index) =>
				delay === 100 ? [timeouts.mock.results[index].value] : [],
			);
			expect(debounceTimers).toHaveLength(type === 'scroll' ? 2 : 1);
			expect(frames.size).toBe(1);

			unmount();
			for (const timer of debounceTimers) expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
			expect(frames.size).toBe(0);
			timeouts.mockClear();
			viewport.scrollTop = 200;
			viewport.dispatchEvent(new Event('scroll'));
			expect(timeouts).not.toHaveBeenCalled();
			expect(frames.size).toBe(0);
		},
	);
});
