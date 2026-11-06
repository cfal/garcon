import { afterEach, expect, it, vi } from 'vitest';
import { getNativeTitlebar, type NativeTitlebar } from '../titlebar';

afterEach(() => {
	delete window.__GARCON_NATIVE__;
});

it('requires an explicit complete desktop capability', () => {
	expect(getNativeTitlebar()).toBeNull();
	for (const value of [
		{ version: 1, requestServerChooser: vi.fn() },
		{ version: 2, titlebar: { requestHidden: vi.fn(), subscribe: vi.fn() } },
		{ version: 1, titlebar: { requestHidden: vi.fn() } },
	]) {
		Object.defineProperty(window, '__GARCON_NATIVE__', { configurable: true, value });
		expect(getNativeTitlebar()).toBeNull();
	}
});

it('preserves host method ownership and subscription cleanup', () => {
	const unsubscribe = vi.fn();
	const titlebar = {
		requestHidden: vi.fn(function (this: NativeTitlebar, hidden: boolean) {
			expect(this).toBe(titlebar);
			expect(hidden).toBe(true);
		}),
		subscribe: vi.fn(function (this: NativeTitlebar, listener) {
			expect(this).toBe(titlebar);
			listener({ hidden: false, failed: false });
			return unsubscribe;
		}),
	} satisfies NativeTitlebar;
	window.__GARCON_NATIVE__ = { version: 1, requestServerChooser: vi.fn(), titlebar };
	const capability = getNativeTitlebar()!;
	capability.requestHidden(true);
	const listener = vi.fn();
	capability.subscribe(listener)();
	expect(listener).toHaveBeenCalledWith({ hidden: false, failed: false });
	expect(unsubscribe).toHaveBeenCalledTimes(1);
});
