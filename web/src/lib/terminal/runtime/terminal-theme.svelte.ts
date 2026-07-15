import type { ITheme } from '@xterm/xterm';

const DARK_THEME: ITheme = {
	background: '#1e1e1e',
	foreground: '#cccccc',
	cursor: '#aeafad',
	cursorAccent: '#000000',
	selectionBackground: '#264f78',
	black: '#000000',
	red: '#cd3131',
	green: '#0dbc79',
	yellow: '#e5e510',
	blue: '#2472c8',
	magenta: '#bc3fbc',
	cyan: '#11a8cd',
	white: '#e5e5e5',
	brightBlack: '#666666',
	brightRed: '#f14c4c',
	brightGreen: '#23d18b',
	brightYellow: '#f5f543',
	brightBlue: '#3b8eea',
	brightMagenta: '#d670d6',
	brightCyan: '#29b8db',
	brightWhite: '#e5e5e5',
};

const LIGHT_THEME: ITheme = {
	background: '#ffffff',
	foreground: '#333333',
	cursor: '#000000',
	cursorAccent: '#ffffff',
	selectionBackground: '#add6ff',
	black: '#000000',
	red: '#cd3131',
	green: '#107c10',
	yellow: '#949800',
	blue: '#0451a5',
	magenta: '#bc05bc',
	cyan: '#0598bc',
	white: '#555555',
	brightBlack: '#666666',
	brightRed: '#cd3131',
	brightGreen: '#14ce14',
	brightYellow: '#b5ba00',
	brightBlue: '#0451a5',
	brightMagenta: '#bc05bc',
	brightCyan: '#0598bc',
	brightWhite: '#a5a5a5',
};

export class TerminalThemeStore {
	#runtimes = new Set<{ applyTheme(theme: ITheme): void }>();
	#isDark = false;

	get theme(): ITheme {
		return this.#isDark ? DARK_THEME : LIGHT_THEME;
	}

	setDark(isDark: boolean): void {
		if (this.#isDark === isDark) return;
		this.#isDark = isDark;
		for (const runtime of this.#runtimes) runtime.applyTheme(this.theme);
	}

	register(runtime: { applyTheme(theme: ITheme): void }): () => void {
		this.#runtimes.add(runtime);
		runtime.applyTheme(this.theme);
		return () => this.#runtimes.delete(runtime);
	}
}
