import { describe, it, expect, vi } from 'vitest';
import { reconcileScrollAfterHeightDelta } from '../scroll-anchor';

describe('reconcileScrollAfterHeightDelta', () => {
	it('keeps the viewport pinned to bottom when requested', () => {
		const scroller = { scrollTop: 120 };
		const pinToBottom = vi.fn();

		reconcileScrollAfterHeightDelta(24, true, scroller, pinToBottom);

		expect(pinToBottom).toHaveBeenCalledTimes(1);
		expect(scroller.scrollTop).toBe(120);
	});

	it('preserves the current viewport anchor when not pinned', () => {
		const scroller = { scrollTop: 120 };
		const pinToBottom = vi.fn();

		reconcileScrollAfterHeightDelta(24, false, scroller, pinToBottom);

		expect(pinToBottom).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(144);
	});

	it('is a no-op for zero-height changes', () => {
		const scroller = { scrollTop: 120 };
		const pinToBottom = vi.fn();

		reconcileScrollAfterHeightDelta(0, false, scroller, pinToBottom);

		expect(pinToBottom).not.toHaveBeenCalled();
		expect(scroller.scrollTop).toBe(120);
	});
});
