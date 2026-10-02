import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindMobileViewport } from '../mobile-viewport-binding';

function createViewport() {
	return Object.assign(new EventTarget(), { height: 800, offsetTop: 0 }) satisfies Pick<
		VisualViewport,
		'height' | 'offsetTop' | 'addEventListener' | 'removeEventListener'
	>;
}

describe('bindMobileViewport', () => {
	let viewport = createViewport();
	let unbind: (() => void) | undefined;
	const onMetrics = vi.fn<Parameters<typeof bindMobileViewport>[0]>();
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrameId = 0;
	const style = document.documentElement.style;

	function flushFrame() {
		const callbacks = [...frames.values()];
		frames.clear();
		for (const callback of callbacks) callback(0);
	}

	beforeEach(() => {
		viewport = createViewport();
		vi.stubGlobal('visualViewport', viewport);
		vi.stubGlobal('innerHeight', 800);
		vi.stubGlobal(
			'requestAnimationFrame',
			vi.fn<typeof requestAnimationFrame>((callback) => {
				const id = ++nextFrameId;
				frames.set(id, callback);
				return id;
			}),
		);
		vi.stubGlobal(
			'cancelAnimationFrame',
			vi.fn<typeof cancelAnimationFrame>((id) => {
				frames.delete(id);
			}),
		);
	});

	afterEach(() => {
		unbind?.();
		unbind = undefined;
		frames.clear();
		onMetrics.mockClear();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('coalesces initial and viewport events into one frame using the latest geometry', () => {
		unbind = bindMobileViewport(onMetrics);
		expect(onMetrics).not.toHaveBeenCalled();
		viewport.height = 500;
		viewport.offsetTop = 120;
		viewport.dispatchEvent(new Event('resize'));
		viewport.dispatchEvent(new Event('scroll'));
		window.dispatchEvent(new Event('resize'));
		expect(frames.size).toBe(1);
		flushFrame();

		expect(onMetrics).toHaveBeenCalledExactlyOnceWith({
			appHeight: 500,
			viewportOffsetTop: 120,
			viewportCenterY: 370,
			keyboardHeight: 300,
			keyboardVisible: true,
		});
		expect(style.getPropertyValue('--app-height')).toBe('500px');
		expect(style.getPropertyValue('--app-viewport-offset-top')).toBe('120px');
		expect(style.getPropertyValue('--app-viewport-center-y')).toBe('370px');
	});

	it('retains the keyboard-closed baseline and previous height through viewport transitions', () => {
		unbind = bindMobileViewport(onMetrics);
		flushFrame();
		vi.stubGlobal('innerHeight', 500);
		viewport.height = 500;
		viewport.dispatchEvent(new Event('resize'));
		flushFrame();
		expect(onMetrics).toHaveBeenLastCalledWith(
			expect.objectContaining({
				appHeight: 500,
				keyboardHeight: 300,
				keyboardVisible: true,
			}),
		);

		viewport.height = 1;
		viewport.dispatchEvent(new Event('resize'));
		flushFrame();
		expect(onMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ appHeight: 500 }));

		viewport.height = 800;
		vi.stubGlobal('innerHeight', 800);
		viewport.dispatchEvent(new Event('resize'));
		flushFrame();
		expect(onMetrics).toHaveBeenLastCalledWith(
			expect.objectContaining({
				keyboardHeight: 0,
				keyboardVisible: false,
			}),
		);
		expect(style.getPropertyValue('--app-height')).toBe('');
		expect(style.getPropertyValue('--app-viewport-offset-top')).toBe('');
		expect(style.getPropertyValue('--app-viewport-center-y')).toBe('');
	});

	it('refreshes on pageshow and visible-only visibility changes', () => {
		unbind = bindMobileViewport(onMetrics);
		flushFrame();
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(frames.size).toBe(0);

		window.dispatchEvent(new Event('pageshow'));
		expect(frames.size).toBe(1);
		flushFrame();
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(frames.size).toBe(1);
		flushFrame();
		expect(onMetrics).toHaveBeenCalledTimes(3);
	});

	it('cancels pending work, removes listeners, and clears overrides on teardown', () => {
		viewport.height = 500;
		unbind = bindMobileViewport(onMetrics);
		flushFrame();
		viewport.dispatchEvent(new Event('resize'));
		expect(frames.size).toBe(1);
		unbind?.();
		unbind = undefined;
		expect(cancelAnimationFrame).toHaveBeenCalledOnce();
		expect(frames.size).toBe(0);
		expect(style.getPropertyValue('--app-height')).toBe('');
		expect(style.getPropertyValue('--app-viewport-offset-top')).toBe('');
		expect(style.getPropertyValue('--app-viewport-center-y')).toBe('');

		viewport.dispatchEvent(new Event('resize'));
		viewport.dispatchEvent(new Event('scroll'));
		window.dispatchEvent(new Event('resize'));
		window.dispatchEvent(new Event('pageshow'));
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		flushFrame();
		expect(onMetrics).toHaveBeenCalledOnce();
		expect(frames.size).toBe(0);
	});

	it('does nothing without visual viewport support', () => {
		vi.stubGlobal('visualViewport', undefined);
		unbind = bindMobileViewport(onMetrics);
		expect(unbind).toBeUndefined();
		expect(requestAnimationFrame).not.toHaveBeenCalled();
		expect(onMetrics).not.toHaveBeenCalled();
	});

	it('does nothing outside the browser', () => {
		vi.stubGlobal('window', undefined);
		unbind = bindMobileViewport(onMetrics);
		expect(unbind).toBeUndefined();
		expect(requestAnimationFrame).not.toHaveBeenCalled();
		expect(onMetrics).not.toHaveBeenCalled();
	});
});
