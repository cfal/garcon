import type { ThemeProfile } from './themes.js';

const HSL_CHANNELS_PATTERN =
	/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))%\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))%$/;

function hslChannelsToRgb(channels: string): string | null {
	const match = HSL_CHANNELS_PATTERN.exec(channels);
	if (!match) return null;

	const hue = ((Number(match[1]) % 360) + 360) % 360;
	const saturation = Number(match[2]) / 100;
	const lightness = Number(match[3]) / 100;
	if (saturation < 0 || saturation > 1 || lightness < 0 || lightness > 1) return null;

	const amplitude = saturation * Math.min(lightness, 1 - lightness);
	const resolveChannel = (offset: number): number => {
		const position = (offset + hue / 30) % 12;
		const value = lightness - amplitude * Math.max(-1, Math.min(position - 3, 9 - position, 1));
		return Math.round(value * 255);
	};
	return `rgb(${resolveChannel(0)}, ${resolveChannel(8)}, ${resolveChannel(4)})`;
}

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
	return hslChannelsToRgb(channels);
}

export function hasResolvedThemeStyles(root: HTMLElement): boolean {
	return getComputedStyle(root).getPropertyValue('--background').trim() !== '';
}
