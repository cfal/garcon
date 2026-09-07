import type { ThemeProfile } from './themes.js';

export function applyThemeToDocument(document: Document, profile: ThemeProfile): void {
	const root = document.documentElement;
	root.dataset.theme = profile.id;
	root.classList.toggle('dark', profile.colorScheme === 'dark');
	root.style.colorScheme = profile.colorScheme;
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute('content', profile.browserThemeColor);
	document
		.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
		?.setAttribute('content', profile.colorScheme === 'dark' ? 'black-translucent' : 'default');
}

export function readTerminalBackground(root: HTMLElement): string | null {
	const channels = getComputedStyle(root).getPropertyValue('--terminal-bg').trim();
	if (!channels) return null;
	const background = `hsl(${channels})`;
	return CSS.supports('color', background) ? background : null;
}
