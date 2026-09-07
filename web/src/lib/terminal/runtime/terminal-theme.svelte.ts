import type { ITheme } from '@xterm/xterm';
import type { ColorScheme, RendererPalette, ThemeRendererPresentation } from '$lib/theme/themes.js';

export interface TerminalThemePresentation extends ThemeRendererPresentation {
	readonly background: string;
}

const STANDARD_DARK_THEME: ITheme = {
	foreground: '#e5e5e5',
	cursor: '#d4d4d4',
	cursorAccent: '#1e1e1e',
	selectionBackground: '#3f6387',
	black: '#8b8b8b',
	red: '#ff7b72',
	green: '#56d88a',
	yellow: '#f6d365',
	blue: '#75b7ff',
	magenta: '#e58be5',
	cyan: '#63d5ea',
	white: '#f5f5f5',
	brightBlack: '#a3a3a3',
	brightRed: '#ff9a91',
	brightGreen: '#7ee2a8',
	brightYellow: '#ffe08a',
	brightBlue: '#9acbff',
	brightMagenta: '#f0aaf0',
	brightCyan: '#8de4f2',
	brightWhite: '#ffffff',
};

const STANDARD_LIGHT_THEME: ITheme = {
	foreground: '#262626',
	cursor: '#000000',
	cursorAccent: '#ffffff',
	selectionBackground: '#a8cdf0',
	black: '#000000',
	red: '#9f1d1d',
	green: '#006b3c',
	yellow: '#665600',
	blue: '#004c99',
	magenta: '#851785',
	cyan: '#00677d',
	white: '#555555',
	brightBlack: '#595959',
	brightRed: '#ad2424',
	brightGreen: '#007a45',
	brightYellow: '#705f00',
	brightBlue: '#0055aa',
	brightMagenta: '#941a94',
	brightCyan: '#00758d',
	brightWhite: '#595959',
};

const COLORBLIND_DARK_THEME: ITheme = {
	...STANDARD_DARK_THEME,
	red: '#ff9f66',
	green: '#66c2ff',
	yellow: '#ffe08a',
	blue: '#7dd3fc',
	magenta: '#d8b4fe',
	cyan: '#67e8f9',
	brightRed: '#ffb98f',
	brightGreen: '#8bd3ff',
	brightYellow: '#ffeaad',
	brightBlue: '#a5e0ff',
	brightMagenta: '#e9d5ff',
	brightCyan: '#a5f3fc',
};

const COLORBLIND_LIGHT_THEME: ITheme = {
	...STANDARD_LIGHT_THEME,
	red: '#943c00',
	green: '#005ea8',
	yellow: '#665600',
	blue: '#005493',
	magenta: '#6b2f86',
	cyan: '#006879',
	brightRed: '#a84700',
	brightGreen: '#006bb8',
	brightYellow: '#705f00',
	brightBlue: '#0063aa',
	brightMagenta: '#7b3996',
	brightCyan: '#007889',
};

const TERMINAL_THEMES: Record<RendererPalette, Record<ColorScheme, ITheme>> = {
	standard: { light: STANDARD_LIGHT_THEME, dark: STANDARD_DARK_THEME },
	colorblind: { light: COLORBLIND_LIGHT_THEME, dark: COLORBLIND_DARK_THEME },
};

const DEFAULT_PRESENTATION: TerminalThemePresentation = {
	colorScheme: 'light',
	rendererPalette: 'standard',
	background: '#ffffff',
};

export function terminalThemeFor(presentation: TerminalThemePresentation): ITheme {
	return {
		...TERMINAL_THEMES[presentation.rendererPalette][presentation.colorScheme],
		background: presentation.background,
	};
}

export class TerminalThemeStore {
	#runtimes = new Set<{ applyTheme(theme: ITheme): void }>();
	#presentation = DEFAULT_PRESENTATION;

	get theme(): ITheme {
		return terminalThemeFor(this.#presentation);
	}

	setPresentation(presentation: TerminalThemePresentation): void {
		if (
			this.#presentation.colorScheme === presentation.colorScheme &&
			this.#presentation.rendererPalette === presentation.rendererPalette &&
			this.#presentation.background === presentation.background
		) {
			return;
		}
		this.#presentation = presentation;
		for (const runtime of this.#runtimes) runtime.applyTheme(this.theme);
	}

	register(runtime: { applyTheme(theme: ITheme): void }): () => void {
		this.#runtimes.add(runtime);
		runtime.applyTheme(this.theme);
		return () => this.#runtimes.delete(runtime);
	}
}
