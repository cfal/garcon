import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	TERMINAL_FALLBACK_FONT_FAMILY,
	TERMINAL_FONT_FAMILY,
	TerminalFontLoader,
} from '../terminal-font.js';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('TerminalFontLoader', () => {
	it('loads and registers the pinned regular and bold faces once', async () => {
		const loadedFontFaces = [{}, {}] as FontFace[];
		let loadedFaceIndex = 0;
		const load = vi.fn(() => Promise.resolve(loadedFontFaces[loadedFaceIndex++]));
		const FontFaceMock = vi.fn(
			class {
				load = load;
			},
		);
		const register = vi.fn();
		vi.stubGlobal('FontFace', FontFaceMock);
		const loader = new TerminalFontLoader(undefined, register, 100);

		const first = loader.load();
		const second = loader.load();

		expect(first).toBe(second);
		await expect(first).resolves.toBe(TERMINAL_FONT_FAMILY);
		expect(FontFaceMock).toHaveBeenCalledTimes(2);
		expect(FontFaceMock).toHaveBeenNthCalledWith(
			1,
			'Monaspace Neon NF',
			expect.stringContaining(
				'@f31794b6e9e65698a062262e2f826f679dcb7070/fonts/Web%20Fonts/NerdFonts%20Web%20Fonts/Monaspace%20Neon/MonaspaceNeonNF-Regular.woff2',
			),
			{ style: 'normal', weight: '400' },
		);
		expect(FontFaceMock).toHaveBeenNthCalledWith(
			2,
			'Monaspace Neon NF',
			expect.stringContaining(
				'@f31794b6e9e65698a062262e2f826f679dcb7070/fonts/Web%20Fonts/NerdFonts%20Web%20Fonts/Monaspace%20Neon/MonaspaceNeonNF-Bold.woff2',
			),
			{ style: 'normal', weight: '700' },
		);
		expect(load).toHaveBeenCalledTimes(2);
		expect(register.mock.calls).toEqual(loadedFontFaces.map((fontFace) => [fontFace]));
	});

	it('returns the fallback family without partial registration when a face cannot load', async () => {
		const availableFontFace = {
			load: vi.fn().mockResolvedValue({} as FontFace),
		} as unknown as FontFace;
		const unavailableFontFace = {
			load: vi.fn().mockRejectedValue(new Error('font unavailable')),
		} as unknown as FontFace;
		const register = vi.fn();
		const loader = new TerminalFontLoader(
			() => [availableFontFace, unavailableFontFace],
			register,
			100,
		);

		await expect(loader.load()).resolves.toBe(TERMINAL_FALLBACK_FONT_FAMILY);
		expect(register).not.toHaveBeenCalled();
	});

	it('falls back before renderer activation times out', async () => {
		vi.useFakeTimers();
		const fontFace = {
			load: vi.fn(() => new Promise<FontFace>(() => undefined)),
		} as unknown as FontFace;
		const loader = new TerminalFontLoader(() => [fontFace], vi.fn(), 100);
		const loading = loader.load();

		await vi.advanceTimersByTimeAsync(100);

		await expect(loading).resolves.toBe(TERMINAL_FALLBACK_FONT_FAMILY);
	});
});
