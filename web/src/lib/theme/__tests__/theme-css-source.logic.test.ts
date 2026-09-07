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

		expect(light).toContain('--git-added: 210 80% 45%;');
		expect(light).toContain('--git-deleted: 30 90% 50%;');
		expect(dark).toContain('--git-added: 210 85% 65%;');
		expect(dark).toContain('--git-deleted: 30 92% 65%;');
		expect(light).not.toMatch(/\.(?:dark\.)?colorblind(?:\s|\{|,)/);
		expect(dark).not.toMatch(/\.(?:dark\.)?colorblind(?:\s|\{|,)/);
	});

	it('pins the distinct Classic and Phosphor foundations', () => {
		expect(profileSource('classic-light')).toContain('--radius: 0.5rem;');
		expect(profileSource('classic-dark')).toContain('--background: 0 0% 10%;');
		expect(profileSource('phosphor-light')).toContain('--radius: 0.75rem;');
		expect(profileSource('phosphor-dark')).toContain('--background: 222 33% 5%;');
	});
});
