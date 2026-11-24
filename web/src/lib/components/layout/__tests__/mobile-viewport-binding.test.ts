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

	function bindDesktop({ wide = true, fine = true, coarse = false, touch = 0 } = {}) {
		const device = { wide, fine, coarse, touch };
		vi.spyOn(window.navigator, 'maxTouchPoints', 'get').mockImplementation(() => device.touch);
		vi.stubGlobal('matchMedia', (query: string): Pick<MediaQueryList, 'matches'> => ({
			get matches() {
				if (query === '(min-width: 769px) and (pointer: fine) and (any-pointer: fine)') {
					return device.wide && device.fine;
				}
				return query === '(any-pointer: coarse)' && device.coarse;
			},
		}));
		unbind = bindMobileViewport(onMetrics);
		flushFrame();
		return device;
	}

	function resize(inner: number, visual = inner, top = 0) {
		vi.stubGlobal('innerHeight', inner);
		viewport.height = visual;
		viewport.offsetTop = top;
		viewport.dispatchEvent(new Event('resize'));
		flushFrame();
		return onMetrics.mock.lastCall?.[0];
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

	it('reports every desktop frame but only rewrites pixel values that changed', () => {
		bindDesktop();
		const writes = vi.spyOn(style, 'setProperty');
		const open = resize(800, 520, 40);
		expect(open).toEqual({
			appHeight: 520, viewportOffsetTop: 40, viewportCenterY: 300,
			keyboardHeight: 280, keyboardVisible: true,
		});
		expect(writes.mock.calls).toEqual([
			['--app-height', '520px'], ['--app-viewport-offset-top', '40px'],
			['--app-viewport-center-y', '300px'],
		]);
		writes.mockClear();
		expect(resize(800, 520, 40)).toEqual(open);
		expect(onMetrics).toHaveBeenCalledTimes(3);
		expect(writes).not.toHaveBeenCalled();

		resize(800, 520, 52.5);
		expect(writes.mock.calls).toEqual([
			['--app-viewport-offset-top', '53px'], ['--app-viewport-center-y', '313px'],
		]);
		writes.mockClear();
		const panned = resize(800, 499.5, 52.5);
		expect(writes.mock.calls).toEqual([
			['--app-height', '500px'], ['--app-viewport-center-y', '303px'],
		]);
		expect(resize(800)?.keyboardVisible).toBe(false);
		expect(style.getPropertyValue('--app-height')).toBe('');
		expect(style.getPropertyValue('--app-viewport-offset-top')).toBe('');
		expect(style.getPropertyValue('--app-viewport-center-y')).toBe('');
		writes.mockClear();
		expect(resize(800, 499.5, 52.5)).toEqual(panned);
		expect(writes).toHaveBeenCalledTimes(3);
		writes.mockClear();
		expect(resize(800, 499.5, 52.5)).toEqual(panned);
		expect(writes).not.toHaveBeenCalled();
	});

	it('repairs missing or higher-priority declarations even at unchanged desktop geometry', () => {
		bindDesktop();
		resize(800, 500);
		style.removeProperty('--app-viewport-offset-top');
		style.setProperty('--app-height', '500px', 'important');
		const writes = vi.spyOn(style, 'setProperty');
		resize(800, 500);
		expect(writes.mock.calls).toEqual([
			['--app-height', '500px'], ['--app-viewport-offset-top', '0px'],
		]);
		expect(style.getPropertyPriority('--app-height')).toBe('');
	});

	it.each([
		['narrow layout', { wide: false }], ['touchscreen', { touch: 5 }],
		['secondary coarse pointer', { coarse: true }], ['no fine primary pointer', { fine: false }],
	] as const)('preserves all viewport writes for %s', (_, device) => {
		bindDesktop(device);
		const metrics = resize(800, 620);
		const writes = vi.spyOn(style, 'setProperty');
		expect(resize(800, 620)).toEqual(metrics);
		expect(writes).toHaveBeenCalledTimes(3);
	});

	it('does not require pointer media queries to publish or refresh a keyboard', () => {
		vi.stubGlobal('matchMedia', undefined);
		unbind = bindMobileViewport(onMetrics);
		flushFrame();
		expect(resize(520)?.keyboardHeight).toBe(280);
		const writes = vi.spyOn(style, 'setProperty');
		expect(resize(520)?.keyboardHeight).toBe(280);
		expect(writes).toHaveBeenCalledTimes(3);
	});

	it('honors layout and pointer changes while the keyboard stays open', () => {
		const device = bindDesktop();
		const expected = resize(800, 520);
		const writes = vi.spyOn(style, 'setProperty');
		for (const [wide, coarse, count] of [
			[false, false, 3], [true, false, 0], [true, true, 3], [true, false, 0],
		] as const) {
			Object.assign(device, { wide, coarse });
			writes.mockClear();
			expect(resize(800, 520)).toEqual(expected);
			expect(writes).toHaveBeenCalledTimes(count);
		}
	});

	it('reports a real keyboard after a native maximize is reversed before the page resizes', () => {
		bindDesktop();
		for (const outer of [998, 1231, 998]) {
			vi.stubGlobal('outerHeight', outer);
			expect(resize(960)?.keyboardVisible).toBe(false);
		}
		expect(resize(680)).toMatchObject({ keyboardVisible: true, keyboardHeight: 280 });
		expect(style.getPropertyValue('--app-height')).toBe('680px');
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
