import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { drawPlasma } from '$lib/theme/ansi-plasma.js';
import AnsiStartup from '../AnsiStartup.svelte';

vi.mock(import('$lib/theme/ansi-plasma.js'), async (importOriginal) => ({
	...(await importOriginal()),
	createPlasmaScene: vi.fn(),
	plasmaGrid: () => ({ columns: 10, rows: 10 }),
	drawPlasma: vi.fn(),
}));

const props = { enabled: true, workspaceReady: true, reduceMotion: false };
const splash = () => document.querySelector('[data-ansi-startup]');
const mediaQueries = new Map<string, EventTarget & { matches: boolean }>();

function pointerEvent(type: string, options: PointerEventInit = {}) {
	return new PointerEvent(type, { bubbles: true, cancelable: true, ...options });
}

function touchEvent(type: string, x = 0, identifier = 1) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'changedTouches', {
		value: [{ clientX: x, clientY: 0, identifier }],
	});
	return event;
}

beforeEach(() => {
	// Uses one clock for performance.now() and animation-frame timestamps.
	vi.useFakeTimers({
		toFake: [
			'setTimeout',
			'clearTimeout',
			'requestAnimationFrame',
			'cancelAnimationFrame',
			'performance',
			'Date',
		],
	});
	vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
	mediaQueries.clear();
	vi.stubGlobal('matchMedia', (media: string) => {
		const query = Object.assign(new EventTarget(), { matches: false, media });
		mediaQueries.set(media, query);
		return query;
	});
	vi.mocked(drawPlasma).mockClear();
	const context = { font: '', textBaseline: 'top' } satisfies Pick<
		CanvasRenderingContext2D,
		'font' | 'textBaseline'
	>;
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
		context as CanvasRenderingContext2D,
	);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('terminal startup', () => {
	it('ends permanently when workspace readiness is lost before the deadline', async () => {
		const { rerender } = render(AnsiStartup, props);
		expect(splash()).not.toBeNull();
		await rerender({ workspaceReady: false });
		expect(splash()).toBeNull();
		await rerender({ workspaceReady: true });
		expect(splash()).toBeNull();
	});

	it.each([{ enabled: false }, { reduceMotion: true }])(
		'dismisses permanently when preferences change mid-intro: %j',
		async (override) => {
			const { rerender } = render(AnsiStartup, props);
			expect(splash()).not.toBeNull();
			await rerender(override);
			expect(splash()).toBeNull();
			await rerender(props);
			expect(splash()).toBeNull();
		},
	);

	it('dismisses permanently when the page becomes hidden', async () => {
		render(AnsiStartup, props);
		expect(splash()).not.toBeNull();
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		document.dispatchEvent(new Event('visibilitychange'));
		await tick();
		expect(splash()).toBeNull();
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
		document.dispatchEvent(new Event('visibilitychange'));
		await tick();
		expect(splash()).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['(prefers-reduced-motion: reduce)', '(forced-colors: active)'])(
		'dismisses permanently when %s starts matching',
		async (query) => {
			render(AnsiStartup, props);
			expect(splash()).not.toBeNull();
			const media = mediaQueries.get(query)!;
			media.matches = true;
			media.dispatchEvent(new Event('change'));
			await tick();
			expect(splash()).toBeNull();
			media.matches = false;
			media.dispatchEvent(new Event('change'));
			await tick();
			expect(splash()).toBeNull();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it('consumes wheel dismissal without intercepting later workspace input', async () => {
		render(AnsiStartup, props);
		const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 });
		splash()!.dispatchEvent(wheel);
		await tick();
		expect(wheel.defaultPrevented).toBe(true);
		expect(splash()).toBeNull();
		const fresh = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 });
		document.body.dispatchEvent(fresh);
		expect(fresh.defaultPrevented).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('caps painting at 16fps and stops at the deadline while a touch retains the overlay', async () => {
		render(AnsiStartup, props);
		splash()!.dispatchEvent(touchEvent('touchstart'));
		await vi.advanceTimersByTimeAsync(1000);
		const firstSecond = vi.mocked(drawPlasma).mock.calls.length;
		expect(firstSecond).toBeGreaterThan(10);
		expect(firstSecond).toBeLessThanOrEqual(17);
		const times = vi.mocked(drawPlasma).mock.calls.map((call) => call[3]);
		for (let index = 1; index < times.length; index++) {
			expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(1 / 16);
		}
		await vi.advanceTimersByTimeAsync(1600);
		expect(splash()).not.toBeNull();
		const atDeadline = vi.mocked(drawPlasma).mock.calls.length;
		expect(atDeadline).toBeGreaterThan(firstSecond);
		expect(atDeadline).toBeLessThanOrEqual(43);
		await vi.advanceTimersByTimeAsync(1000);
		expect(drawPlasma).toHaveBeenCalledTimes(atDeadline);
		expect(vi.getTimerCount()).toBe(0);
		splash()!.dispatchEvent(touchEvent('touchend'));
		await tick();
		expect(splash()).toBeNull();
	});

	it('waits for keyboard ownership without extending the original deadline', async () => {
		const { rerender } = render(AnsiStartup, { ...props, workspaceReady: false });
		expect(splash()).toBeNull();
		await vi.advanceTimersByTimeAsync(2000);
		await rerender({ workspaceReady: true });
		expect(splash()).not.toBeNull();
		await vi.advanceTimersByTimeAsync(600);
		expect(splash()).toBeNull();
		await rerender({ workspaceReady: false });
		await rerender({ workspaceReady: true });
		expect(splash()).toBeNull();
	});

	it.each([{ enabled: false }, { reduceMotion: true }])(
		'never replays an initially skipped boot: %j',
		async (override) => {
			const { rerender } = render(AnsiStartup, { ...props, ...override });
			expect(splash()).toBeNull();
			await rerender(props);
			expect(splash()).toBeNull();
		},
	);

	it.each(['(prefers-reduced-motion: reduce)', '(forced-colors: active)'])('skips %s', (query) => {
		vi.stubGlobal('matchMedia', (media: string) =>
			Object.assign(new EventTarget(), { matches: media === query, media }),
		);
		render(AnsiStartup, props);
		expect(splash()).toBeNull();
	});

	it('dismisses synchronously through the keyboard owner and cancels work on unmount', async () => {
		const { component, unmount } = render(AnsiStartup, props);
		expect(splash()).not.toBeNull();
		component.dismiss();
		await tick();
		expect(splash()).toBeNull();
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('consumes the dismissing click and its double-click continuation only', async () => {
		render(AnsiStartup, props);
		const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
		splash()!.dispatchEvent(click);
		await tick();
		expect(click.defaultPrevented).toBe(true);
		expect(splash()).toBeNull();
		const press = pointerEvent('pointerdown', {
			pointerType: 'mouse',
			detail: 0,
		});
		document.body.dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);
		const mousePress = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 });
		document.body.dispatchEvent(mousePress);
		expect(mousePress.defaultPrevented).toBe(true);
		document.body.dispatchEvent(
			pointerEvent('pointerup', { pointerType: 'mouse', cancelable: false }),
		);
		const elsewhere = pointerEvent('pointerdown', {
			pointerType: 'mouse',
			clientX: 40,
		});
		document.body.dispatchEvent(elsewhere);
		expect(elsewhere.defaultPrevented).toBe(false);
		const repeated = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 });
		document.body.dispatchEvent(repeated);
		expect(repeated.defaultPrevented).toBe(true);
		await vi.advanceTimersByTimeAsync(400);
		const fresh = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
		document.body.dispatchEvent(fresh);
		expect(fresh.defaultPrevented).toBe(false);
		const freshPress = pointerEvent('pointerdown', {
			pointerType: 'mouse',
		});
		document.body.dispatchEvent(freshPress);
		expect(freshPress.defaultPrevented).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['touchend', 'touchcancel'])('owns touch gestures until %s', async (end) => {
		render(AnsiStartup, props);
		const touch = touchEvent('touchstart');
		splash()!.dispatchEvent(touch);
		await tick();
		expect(touch.defaultPrevented).toBe(true);
		expect(splash()).not.toBeNull();
		splash()!.dispatchEvent(touchEvent(end, 100));
		await tick();
		expect(splash()).toBeNull();
		for (const type of ['pointerdown', 'pointerup']) {
			const repeated = pointerEvent(type, {
				pointerType: 'touch',
				clientX: 110,
			});
			document.body.dispatchEvent(repeated);
			expect(repeated.defaultPrevented).toBe(true);
		}
		const repeatedTouch = touchEvent('touchstart', 110);
		document.body.dispatchEvent(repeatedTouch);
		expect(repeatedTouch.defaultPrevented).toBe(true);
		const elsewhere = touchEvent('touchstart', 40);
		document.body.dispatchEvent(elsewhere);
		expect(elsewhere.defaultPrevented).toBe(false);
		await vi.advanceTimersByTimeAsync(400);
		expect(vi.getTimerCount()).toBe(0);
		const fresh = touchEvent('touchstart', 100);
		document.body.dispatchEvent(fresh);
		expect(fresh.defaultPrevented).toBe(false);
	});

	it.each(['deadline', 'dismiss'])('retains active touches through %s', async (reason) => {
		const { component } = render(AnsiStartup, props);
		splash()!.dispatchEvent(touchEvent('touchstart', 20));
		if (reason === 'deadline') await vi.advanceTimersByTimeAsync(2600);
		else component.dismiss();
		await tick();
		expect(splash()).not.toBeNull();
		splash()!.dispatchEvent(touchEvent('touchend', 40));
		await tick();
		expect(splash()).toBeNull();
	});

	it('retains the overlay until every owned contact has finished', async () => {
		render(AnsiStartup, props);
		splash()!.dispatchEvent(touchEvent('touchstart', 20, 1));
		splash()!.dispatchEvent(touchEvent('touchstart', 40, 2));
		splash()!.dispatchEvent(touchEvent('touchend', 20, 1));
		await tick();
		expect(splash()).not.toBeNull();
		splash()!.dispatchEvent(touchEvent('touchend', 40, 2));
		await tick();
		expect(splash()).toBeNull();
	});

	it('retains consumed repeat pointers through expiry and movement', async () => {
		render(AnsiStartup, props);
		splash()!.dispatchEvent(touchEvent('touchstart'));
		splash()!.dispatchEvent(touchEvent('touchend'));
		await tick();
		await vi.advanceTimersByTimeAsync(330);
		const press = pointerEvent('pointerdown', {
			pointerType: 'touch',
			pointerId: 7,
			clientX: 10,
		});
		document.body.dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);
		await vi.advanceTimersByTimeAsync(600);
		const release = pointerEvent('pointerup', {
			pointerType: 'touch',
			pointerId: 7,
			clientX: 100,
		});
		document.body.dispatchEvent(release);
		expect(release.defaultPrevented).toBe(true);
		await vi.advanceTimersByTimeAsync(400);
		const fresh = touchEvent('touchstart');
		document.body.dispatchEvent(fresh);
		expect(fresh.defaultPrevented).toBe(false);
	});

	it('prevents mouse presses from moving focus without dismissing before click', () => {
		render(AnsiStartup, props);
		const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		splash()!.dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);
		expect(splash()).not.toBeNull();
	});

	it.each(['mouse', 'pen'])('owns the %s click after a moved release', async (pointerType) => {
		render(AnsiStartup, props);
		splash()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await tick();
		const options = { pointerType, pointerId: 11 };
		document.body.dispatchEvent(pointerEvent('pointerdown', options));
		const clientX = pointerType === 'mouse' ? 10 : 40;
		const release = pointerEvent('pointerup', { ...options, clientX });
		document.body.dispatchEvent(release);
		expect(release.defaultPrevented).toBe(true);
		const click = pointerEvent('click', { ...options, clientX, detail: 1 });
		document.body.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		const doubleClick = new MouseEvent('dblclick', {
			bubbles: true,
			cancelable: true,
			clientX,
			detail: 2,
		});
		document.body.dispatchEvent(doubleClick);
		expect(doubleClick.defaultPrevented).toBe(true);
		const freshClick = pointerEvent('click', { ...options, clientX, detail: 1 });
		document.body.dispatchEvent(freshClick);
		expect(freshClick.defaultPrevented).toBe(false);
	});

	it.each(['pointerup', 'pointercancel'])(
		'leaves unowned %s near the origin untouched',
		async (type) => {
			render(AnsiStartup, props);
			splash()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await tick();
			const options = { pointerType: 'touch', pointerId: 7 };
			const press = pointerEvent('pointerdown', { ...options, clientX: 100 });
			document.body.dispatchEvent(press);
			expect(press.defaultPrevented).toBe(false);
			await vi.advanceTimersByTimeAsync(200);
			const release = pointerEvent(type, options);
			document.body.dispatchEvent(release);
			expect(release.defaultPrevented).toBe(false);
			await vi.advanceTimersByTimeAsync(200);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it('does not consume clicks on top-layer UI outside the splash', () => {
		render(AnsiStartup, props);
		const click = new MouseEvent('click', { bubbles: true, cancelable: true });
		document.body.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(false);
		expect(splash()).not.toBeNull();
	});

	it('dismisses when canvas is unavailable', () => {
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
		render(AnsiStartup, props);
		expect(splash()).toBeNull();
	});
});
