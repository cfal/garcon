import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNativeServerChooser } from '../server-chooser';

afterEach(() => {
	delete window.__GARCON_NATIVE__;
});

describe('native server chooser capability', () => {
	it('is absent in ordinary browsers', () => {
		expect(getNativeServerChooser()).toBeNull();
	});

	it('ignores unknown host versions and incomplete capabilities', () => {
		for (const value of [{ version: 2, requestServerChooser: vi.fn() }, { version: 1 }]) {
			Object.defineProperty(window, '__GARCON_NATIVE__', { configurable: true, value });
			expect(getNativeServerChooser()).toBeNull();
		}
	});
	it('exposes only the chooser request', () => {
		const requestServerChooser = vi.fn();
		window.__GARCON_NATIVE__ = { version: 1, requestServerChooser };
		const chooser = getNativeServerChooser();
		expect(Object.keys(chooser!)).toEqual(['requestServerChooser']);
		chooser!.requestServerChooser();
		expect(requestServerChooser).toHaveBeenCalledWith();
	});
	it('propagates failure without browser navigation fallback', () => {
		window.__GARCON_NATIVE__ = {
			version: 1,
			requestServerChooser() {
				throw new Error('Unavailable');
			},
		};
		expect(() => getNativeServerChooser()!.requestServerChooser()).toThrow('Unavailable');
	});
});
