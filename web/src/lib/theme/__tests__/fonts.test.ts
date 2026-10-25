import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalFonts: PropertyDescriptor | undefined;
beforeEach(() => {
	originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
});

function installFonts(load: FontFaceSet['load']): void {
	Object.defineProperty(document, 'fonts', {
		configurable: true,
		value: { load } satisfies Pick<FontFaceSet, 'load'>,
	});
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.resetModules();
	if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
	else Reflect.deleteProperty(document, 'fonts');
});

describe('Departure font loading', () => {
	it.each([true, false])(
		'shares the request and checks matching faces (loaded: %s)',
		async (loaded) => {
			const load = vi.fn().mockResolvedValue(loaded ? [{ status: 'loaded' }] : []);
			installFonts(load);
			const { loadDepartureMono } = await import('../fonts.js');
			const first = loadDepartureMono();
			expect(loadDepartureMono()).toBe(first);
			await expect(first).resolves.toBe(loaded);
			expect(load).toHaveBeenCalledExactlyOnceWith('400 16px "Departure Mono"');
		},
	);

	it('falls back on failure and on a request that never resolves', async () => {
		vi.useFakeTimers();
		const load = vi.fn().mockRejectedValue(new Error('unavailable'));
		installFonts(load);
		await expect((await import('../fonts.js')).loadDepartureMono()).resolves.toBe(false);
		vi.resetModules();
		load.mockImplementation(() => new Promise(() => {}));
		const pending = (await import('../fonts.js')).loadDepartureMono();
		await vi.advanceTimersByTimeAsync(4000);
		await expect(pending).resolves.toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});
