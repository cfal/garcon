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
			const { loadFont } = await import('../fonts.js');
			const first = loadFont('departure-mono');
			expect(loadFont('departure-mono')).toBe(first);
			await expect(first).resolves.toBe(loaded);
			expect(load).toHaveBeenCalledExactlyOnceWith('400 16px "Departure Mono"');
		},
	);

	it('falls back on failure and on a request that never resolves', async () => {
		vi.useFakeTimers();
		const load = vi.fn().mockRejectedValue(new Error('unavailable'));
		installFonts(load);
		await expect((await import('../fonts.js')).loadFont('departure-mono')).resolves.toBe(false);
		vi.resetModules();
		load.mockImplementation(() => new Promise(() => {}));
		const pending = (await import('../fonts.js')).loadFont('departure-mono');
		await vi.advanceTimersByTimeAsync(4000);
		await expect(pending).resolves.toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['failure', 'timeout'] as const)('retries after a bundled font %s', async (result) => {
		vi.useFakeTimers();
		const load = vi.fn<FontFaceSet['load']>();
		if (result === 'failure') load.mockRejectedValueOnce(new Error('unavailable'));
		else load.mockImplementationOnce(() => new Promise(() => {}));
		load.mockResolvedValue([{ status: 'loaded' } as FontFace]);
		installFonts(load);
		const { loadFont } = await import('../fonts.js');
		const failed = loadFont('jetbrains-mono');
		await vi.advanceTimersByTimeAsync(4000);
		await expect(failed).resolves.toBe(false);
		const retry = loadFont('jetbrains-mono');
		expect(retry).not.toBe(failed);
		await expect(retry).resolves.toBe(true);
		expect(loadFont('jetbrains-mono')).toBe(retry);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('loads only the selected bundled face and leaves system choices alone', async () => {
		const load = vi.fn().mockResolvedValue([{ status: 'loaded' }]);
		installFonts(load);
		const { loadFont } = await import('../fonts.js');
		await loadFont('system-serif');
		expect(load).not.toHaveBeenCalled();
		await loadFont('jetbrains-mono');
		await loadFont('inter');
		expect(load.mock.calls).toEqual([['400 16px "JetBrains Mono"'], ['400 16px "Inter"']]);
	});
});
