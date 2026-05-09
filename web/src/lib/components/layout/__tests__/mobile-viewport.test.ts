import { describe, expect, it } from 'vitest';
import { computeMobileViewportMetrics } from '../mobile-viewport';

describe('computeMobileViewportMetrics', () => {
	it('uses visual viewport height without subtracting offsetTop', () => {
		const metrics = computeMobileViewportMetrics({
			visualViewportHeight: 500,
			visualViewportOffsetTop: 120,
			windowInnerHeight: 800,
		});

		expect(metrics.appHeight).toBe(500);
		expect(metrics.viewportOffsetTop).toBe(120);
		expect(metrics.keyboardHeight).toBe(300);
		expect(metrics.keyboardVisible).toBe(true);
	});

	it('falls back to the previous app height for transient tiny viewport heights', () => {
		const metrics = computeMobileViewportMetrics({
			visualViewportHeight: 1,
			visualViewportOffsetTop: 0,
			windowInnerHeight: 800,
			previousAppHeight: 720,
		});

		expect(metrics.appHeight).toBe(720);
		expect(metrics.keyboardVisible).toBe(true);
	});

	it('uses the pre-keyboard baseline when innerHeight shrinks with the visual viewport', () => {
		const metrics = computeMobileViewportMetrics({
			visualViewportHeight: 500,
			visualViewportOffsetTop: 0,
			windowInnerHeight: 500,
			baselineAppHeight: 800,
		});

		expect(metrics.appHeight).toBe(500);
		expect(metrics.keyboardHeight).toBe(300);
		expect(metrics.keyboardVisible).toBe(true);
	});

	it('reports the keyboard hidden when the viewport matches the window height', () => {
		const metrics = computeMobileViewportMetrics({
			visualViewportHeight: 800,
			visualViewportOffsetTop: 0,
			windowInnerHeight: 800,
		});

		expect(metrics.appHeight).toBe(800);
		expect(metrics.viewportOffsetTop).toBe(0);
		expect(metrics.keyboardHeight).toBe(0);
		expect(metrics.keyboardVisible).toBe(false);
	});
});
