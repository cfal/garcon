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

describe('bundled font loading', () => {
	it.each([true, false])(
		'shares the request and checks matching faces (loaded: %s)',
		async (loaded) => {
			const load = vi.fn().mockResolvedValue(loaded ? [{ status: 'loaded' }] : []);
			installFonts(load);
			const { loadFont } = await import('../fonts.js');
			const first = loadFont('departure-mono');
			expect(loadFont('departure-mono')).toBe(first);
			await expect(first).resolves.toBe(loaded);
			expect(load.mock.calls).toEqual(
				['400', '700', 'italic 400', 'italic 700'].map((style) => [
					`${style} 16px "Departure Mono"`,
				]),
			);
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
		const load = vi.fn();
		if (result === 'failure') load.mockRejectedValueOnce(new Error('unavailable'));
		else load.mockImplementationOnce(() => new Promise(() => {}));
		load.mockResolvedValue([{ status: 'loaded' } satisfies Pick<FontFace, 'status'>]);
		installFonts(load);
		const { loadFont } = await import('../fonts.js');
		const failed = loadFont('jetbrains-mono');
		await vi.advanceTimersByTimeAsync(4000);
		await expect(failed).resolves.toBe(false);
		const retry = loadFont('jetbrains-mono');
		expect(retry).not.toBe(failed);
		await expect(retry).resolves.toBe(true);
		expect(loadFont('jetbrains-mono')).toBe(retry);
		expect(load).toHaveBeenCalledTimes(8);
	});

	it('loads every style of each bundled family and leaves system choices alone', async () => {
		const load = vi.fn().mockResolvedValue([{ status: 'loaded' }]);
		installFonts(load);
		const { loadFont, BUNDLED_FONT_FAMILIES, FONT_OPTIONS, parseFontPreference } =
			await import('../fonts.js');
		for (const font of ['default', 'system-sans', 'system-serif', 'system-mono'] as const)
			await loadFont(font);
		expect(load).not.toHaveBeenCalled();
		for (const font of FONT_OPTIONS) {
			expect(parseFontPreference(font)).toBe(font);
			await loadFont(font);
		}
		expect(load.mock.calls).toEqual(
			Object.values(BUNDLED_FONT_FAMILIES).flatMap((family) =>
				['400', '700', 'italic 400', 'italic 700'].map((style) => [`${style} 16px ${family}`]),
			),
		);
	});

	it('does not publish a font while its bold face is still loading', async () => {
		vi.useFakeTimers();
		const bold = Promise.withResolvers<Pick<FontFace, 'status'>[]>();
		const loadedFaces = [{ status: 'loaded' } satisfies Pick<FontFace, 'status'>];
		const load = vi
			.fn()
			.mockImplementation((font: string) =>
				font.startsWith('700 ') ? bold.promise : Promise.resolve(loadedFaces),
			);
		installFonts(load);
		const { loadFont } = await import('../fonts.js');
		let resolved = false;
		const loading = loadFont('ibm-plex-mono').then((loaded) => {
			resolved = true;
			return loaded;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(resolved).toBe(false);
		expect(load).toHaveBeenCalledWith('700 16px "IBM Plex Mono"');
		bold.resolve(loadedFaces);
		await expect(loading).resolves.toBe(true);
	});
});
