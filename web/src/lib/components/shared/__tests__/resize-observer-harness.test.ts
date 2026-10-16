import { expect, it, vi } from 'vitest';
import { installResizeObserverHarness, ResizeObserverHarness } from './resize-observer-harness.js';

it('delivers a resize to every subscriber, including shared observers', () => {
	const restore = installResizeObserverHarness();
	try {
		const target = document.createElement('div');
		const first = vi.fn();
		const second = vi.fn();
		const removed = vi.fn();
		new ResizeObserver(first).observe(target);
		new ResizeObserver(second).observe(target);
		const stale = new ResizeObserver(removed);
		stale.observe(target);
		stale.unobserve(target);
		ResizeObserverHarness.emit(target, 900, 600);
		for (const callback of [first, second]) {
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback.mock.calls[0][0][0]).toMatchObject({
				target,
				contentRect: { width: 900, height: 600 },
			});
		}
		expect(removed).not.toHaveBeenCalled();
	} finally {
		restore();
	}
});
