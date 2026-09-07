import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_PROFILES, type ThemeId } from '../themes.js';

const PROFILE_ROLE_PROPERTIES = [
	'--control-radius',
	'--menu-radius',
	'--menu-item-radius',
	'--dialog-radius',
	'--dialog-close-radius',
	'--menu-padding',
	'--menu-shadow',
	'--submenu-shadow',
	'--tooltip-shadow',
	'--dialog-shadow',
	'--primary-hover-shadow',
	'--dialog-surface',
	'--scroll-area-thumb',
	'--scroll-area-thumb-hover',
	'--switch-thumb-checked',
	'--switch-thumb-unchecked',
	'--native-select-muted-background',
	'--native-select-surface-background',
	'--native-select-border',
	'--native-select-radius',
	'--native-select-compact-radius',
] as const;

function profileSource(themeId: ThemeId): string {
	return readFileSync(new URL(`../profiles/${themeId}.css`, import.meta.url), 'utf8');
}

function declaredProperties(source: string): Set<string> {
	return new Set(source.match(/--[a-z0-9-]+(?=\s*:)/g) ?? []);
}

function propertyValues(source: string): Record<string, string> {
	return Object.fromEntries(
		[...source.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
	);
}

function relativeLuminance(hsl: string): number {
	return relativeLuminanceFromChannels(hslToSrgbChannels(hsl));
}

type ColorChannels = readonly [red: number, green: number, blue: number];

function hslToSrgbChannels(hsl: string): ColorChannels {
	const [hue, saturationPercent, lightnessPercent] = hsl
		.split(/\s+/)
		.map((part) => Number.parseFloat(part));
	const saturation = saturationPercent / 100;
	const lightness = lightnessPercent / 100;
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const intermediate = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
	const offset = lightness - chroma / 2;
	let channels: ColorChannels;
	if (hue < 60) channels = [chroma, intermediate, 0];
	else if (hue < 120) channels = [intermediate, chroma, 0];
	else if (hue < 180) channels = [0, chroma, intermediate];
	else if (hue < 240) channels = [0, intermediate, chroma];
	else if (hue < 300) channels = [intermediate, 0, chroma];
	else channels = [chroma, 0, intermediate];
	return [channels[0] + offset, channels[1] + offset, channels[2] + offset];
}

function relativeLuminanceFromChannels(channels: ColorChannels): number {
	return channels
		.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
		.reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(background: string, foreground: string): number {
	const backgroundLuminance = relativeLuminance(background);
	const foregroundLuminance = relativeLuminance(foreground);
	return (
		(Math.max(backgroundLuminance, foregroundLuminance) + 0.05) /
		(Math.min(backgroundLuminance, foregroundLuminance) + 0.05)
	);
}

function contrastRatioOnSelfTint(surface: string, foreground: string, opacity: number): number {
	const surfaceChannels = hslToSrgbChannels(surface);
	const foregroundChannels = hslToSrgbChannels(foreground);
	const tintedChannels: ColorChannels = [
		foregroundChannels[0] * opacity + surfaceChannels[0] * (1 - opacity),
		foregroundChannels[1] * opacity + surfaceChannels[1] * (1 - opacity),
		foregroundChannels[2] * opacity + surfaceChannels[2] * (1 - opacity),
	];
	const surfaceLuminance = relativeLuminanceFromChannels(tintedChannels);
	const foregroundLuminance = relativeLuminanceFromChannels(foregroundChannels);
	return (
		(Math.max(surfaceLuminance, foregroundLuminance) + 0.05) /
		(Math.min(surfaceLuminance, foregroundLuminance) + 0.05)
	);
}

describe('theme profile CSS sources', () => {
	it('ships one complete stylesheet for every registered profile', () => {
		const [reference, ...rest] = THEME_PROFILES;
		const referenceProperties = [...declaredProperties(profileSource(reference.id))].sort();

		for (const profile of rest) {
			expect([...declaredProperties(profileSource(profile.id))].sort()).toEqual(
				referenceProperties,
			);
		}
	});

	it('keeps viewport geometry outside visual profiles', () => {
		for (const profile of THEME_PROFILES) {
			const properties = declaredProperties(profileSource(profile.id));
			expect(properties.has('--safe-area-inset-top')).toBe(false);
			expect(properties.has('--mobile-nav-height')).toBe(false);
			expect(properties.has('--app-height')).toBe(false);
		}
	});

	it('defines every primitive appearance role in every profile', () => {
		for (const profile of THEME_PROFILES) {
			const properties = declaredProperties(profileSource(profile.id));
			for (const property of PROFILE_ROLE_PROPERTIES) expect(properties.has(property)).toBe(true);
		}
	});

	it('materializes colorblind semantic overrides without a modifier selector', () => {
		const light = profileSource('colorblind-light');
		const dark = profileSource('colorblind-dark');

		expect(light).toContain('--git-added: 210 80% 30%;');
		expect(light).toContain('--git-deleted: 30 90% 26%;');
		expect(dark).toContain('--git-added: 210 85% 77%;');
		expect(dark).toContain('--git-deleted: 30 92% 68%;');
		expect(light).not.toMatch(/\.(?:dark\.)?colorblind(?:\s|\{|,)/);
		expect(dark).not.toMatch(/\.(?:dark\.)?colorblind(?:\s|\{|,)/);
	});

	it('pins the distinct Classic and Phosphor foundations', () => {
		expect(profileSource('classic-light')).toContain('--radius: 0.5rem;');
		expect(profileSource('classic-dark')).toContain('--background: 0 0% 10%;');
		expect(profileSource('phosphor-light')).toContain('--radius: 0.75rem;');
		expect(profileSource('phosphor-dark')).toContain('--background: 222 33% 5%;');
	});

	it('keeps Phosphor scrollbar fallbacks aligned with WebKit painting', () => {
		for (const [themeId, opacity] of [
			['phosphor-light', '0.52'],
			['phosphor-dark', '0.42'],
		] as const) {
			const source = profileSource(themeId);
			expect(
				source.match(new RegExp(`hsl\\(var\\(--foreground\\) / ${opacity}\\)`, 'g')),
			).toHaveLength(3);
		}
	});

	it('keeps application-owned semantic text pairs above minimum contrast', () => {
		const pairs = [
			['background', 'foreground'],
			['card', 'card-foreground'],
			['popover', 'popover-foreground'],
			['primary', 'primary-foreground'],
			['secondary', 'secondary-foreground'],
			['muted', 'muted-foreground'],
			['accent', 'accent-foreground'],
			['destructive', 'destructive-foreground'],
			['sidebar-background', 'sidebar-foreground'],
			['sidebar-primary', 'sidebar-primary-foreground'],
			['sidebar-accent', 'sidebar-accent-foreground'],
			['status-info', 'status-info-foreground'],
			['status-success', 'status-success-foreground'],
			['status-error', 'status-error-foreground'],
			['status-neutral', 'status-neutral-foreground'],
			['status-warning', 'status-warning-foreground'],
			['stop-button-bg', 'stop-button-foreground'],
			['user-bubble', 'user-bubble-foreground'],
			['markdown-code-background', 'markdown-code-foreground'],
			['interactive-accent', 'interactive-accent-foreground'],
			['git-action-commit', 'git-action-foreground'],
			['git-action-commit-hover', 'git-action-foreground'],
			['git-action-pull', 'git-action-foreground'],
			['git-action-pull-hover', 'git-action-foreground'],
			['git-action-push', 'git-action-foreground'],
			['git-action-push-hover', 'git-action-foreground'],
			['git-action-publish', 'git-action-foreground'],
			['git-action-publish-hover', 'git-action-foreground'],
		] as const;
		const foregrounds = [
			'git-added',
			'git-deleted',
			'git-modified',
			'git-renamed',
			'git-untracked',
			'interactive-accent',
		] as const;
		const selfTintedForegrounds = ['git-added', 'git-deleted'] as const;
		const surfaces = ['background', 'sidebar-background', 'muted'] as const;

		for (const profile of THEME_PROFILES) {
			const values = propertyValues(profileSource(profile.id));
			for (const [background, foreground] of pairs) {
				expect(
					contrastRatio(values[background], values[foreground]),
					`${profile.id}: ${background}/${foreground}`,
				).toBeGreaterThanOrEqual(4.5);
			}
			for (const foreground of foregrounds) {
				for (const surface of surfaces) {
					expect(
						contrastRatio(values[surface], values[foreground]),
						`${profile.id}: ${foreground} on ${surface}`,
					).toBeGreaterThanOrEqual(4.5);
				}
			}
			for (const foreground of selfTintedForegrounds) {
				for (const opacity of [0.2, 0.3]) {
					expect(
						contrastRatioOnSelfTint(values.background, values[foreground], opacity),
						`${profile.id}: ${foreground} on ${opacity * 100}% self tint`,
					).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	});
});
