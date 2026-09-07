import { describe, expect, it, vi } from 'vitest';
import { TerminalThemeStore, terminalThemeFor } from '../terminal-theme.svelte.js';
import type { TerminalThemePresentation } from '../terminal-theme.svelte.js';

const DEFAULT_BACKGROUND_FOREGROUND_KEYS = [
	'foreground',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
	'brightBlack',
	'brightRed',
	'brightGreen',
	'brightYellow',
	'brightBlue',
	'brightMagenta',
	'brightCyan',
	'brightWhite',
] as const;

function luminance(hex: string): number {
	const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
	const [red, green, blue] = channels.map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
	const lighter = Math.max(luminance(first), luminance(second));
	const darker = Math.min(luminance(first), luminance(second));
	return (lighter + 0.05) / (darker + 0.05);
}

const PRESENTATIONS: TerminalThemePresentation[] = [
	{ colorScheme: 'light', rendererPalette: 'standard', background: '#ffffff' },
	{ colorScheme: 'dark', rendererPalette: 'standard', background: '#1e1e1e' },
	{ colorScheme: 'light', rendererPalette: 'colorblind', background: '#ffffff' },
	{ colorScheme: 'dark', rendererPalette: 'colorblind', background: '#1e1e1e' },
];

describe('terminal themes', () => {
	it('keeps configured foreground colors readable on the default background', () => {
		for (const presentation of PRESENTATIONS) {
			const theme = terminalThemeFor(presentation);
			for (const key of DEFAULT_BACKGROUND_FOREGROUND_KEYS) {
				const color = theme[key];
				if (typeof color !== 'string') throw new Error(`Missing terminal ${key}`);
				expect(
					contrast(color, presentation.background),
					`${presentation.rendererPalette} ${presentation.colorScheme} ${key}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it('keeps explicit ANSI black backgrounds compatible with light foregrounds', () => {
		for (const presentation of PRESENTATIONS.filter(({ colorScheme }) => colorScheme === 'dark')) {
			const theme = terminalThemeFor(presentation);
			const background = theme.black;
			if (typeof background !== 'string') throw new Error('Missing terminal black');
			expect(background).toBe('#000000');
			for (const foregroundKey of ['red', 'brightWhite'] as const) {
				const foreground = theme[foregroundKey];
				if (typeof foreground !== 'string') {
					throw new Error(`Missing terminal ${foregroundKey}`);
				}
				expect(
					contrast(foreground, background),
					`${presentation.rendererPalette} ${foregroundKey} on black`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it('updates runtimes only when the effective presentation changes', () => {
		const store = new TerminalThemeStore();
		const first = { applyTheme: vi.fn() };
		store.register(first);
		expect(first.applyTheme).toHaveBeenCalledOnce();

		const presentation = PRESENTATIONS[2];
		store.setPresentation(presentation);
		store.setPresentation({ ...presentation });
		expect(first.applyTheme).toHaveBeenCalledTimes(2);

		const second = { applyTheme: vi.fn() };
		store.register(second);
		expect(second.applyTheme).toHaveBeenCalledWith(terminalThemeFor(presentation));
	});
});
