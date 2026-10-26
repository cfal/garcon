import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FONT_OPTIONS } from '../fonts';
import {
	createLocalSettingsStore,
	type LocalSettingsStore,
} from '$lib/stores/local-settings.svelte';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import {
	TYPOGRAPHY_DEFAULTS,
	TYPOGRAPHY_SURFACES,
	TYPOGRAPHY_SIZE_OPTIONS,
	parseTypographyPreferences,
	parseSurfaceFont,
	typographyFontOverride,
	typographyScale,
	readTypographyScale,
} from '../typography';

describe('scoped typography preferences', () => {
	it('preserves existing Departure fallback families by owner', () => {
		for (const surface of ['chat-list', 'chat-feed', 'chat-output'] as const)
			expect(typographyFontOverride(surface, 'departure-mono')).toBe(
				'"Departure Mono", var(--system-ui-font)',
			);
		for (const surface of ['chat-code', 'code-editor', 'expanded-editor', 'code-diff'] as const)
			expect(typographyFontOverride(surface, 'departure-mono')).toBe(
				'"Departure Mono", var(--system-code-font)',
			);
		expect(typographyFontOverride('interface', 'departure-mono')).toBe(
			'var(--font-choice-departure-mono)',
		);
	});
	const stores: LocalSettingsStore[] = [];
	function createStore() {
		const store = createLocalSettingsStore();
		stores.push(store);
		return store;
	}
	beforeEach(() => localStorage.clear());
	afterEach(() => {
		for (const store of stores.splice(0)) store.destroy();
	});

	it('keeps all surfaces at their renderer defaults', () => {
		expect(parseTypographyPreferences({})).toEqual(TYPOGRAPHY_DEFAULTS);
		expect(createStore().snapshot()).toMatchObject(TYPOGRAPHY_DEFAULTS);
	});

	it.each(TYPOGRAPHY_SURFACES)(
		'uses the $id scale for preferences and DOM reads',
		({ id, defaultSize }) => {
			const attribute = `data-${id}-font-size`;
			try {
				for (const size of TYPOGRAPHY_SIZE_OPTIONS) {
					const expected = size === 'default' ? 1 : Number(size) / defaultSize;
					expect(typographyScale(id, size)).toBe(expected);
					document.documentElement.setAttribute(attribute, size);
					expect(readTypographyScale(document, id)).toBe(expected);
				}
				document.documentElement.setAttribute(attribute, 'invalid');
				expect(readTypographyScale(document, id)).toBe(1);
				document.documentElement.removeAttribute(attribute);
				expect(readTypographyScale(document, id)).toBe(1);
			} finally {
				document.documentElement.removeAttribute(attribute);
			}
		},
	);

	it.each([undefined, null, 'default'])(
		'keeps numeric sizes literal regardless of Interface size %s',
		(interfaceFontSize) => {
			const sizes = { codeEditorFontSize: '12', gitDiffFontSize: '12', terminalFontSize: '13' };
			const preferences = Object.freeze({ ...sizes, interfaceFontSize });
			expect(parseTypographyPreferences(preferences)).toEqual({ ...TYPOGRAPHY_DEFAULTS, ...sizes });
		},
	);

	it.each([undefined, 'default', null, 'bad'])(
		'keeps missing or defaulted owners independent (%s)',
		(value) => {
			expect(
				parseTypographyPreferences({
					codeEditorFont: 'jetbrains-mono',
					codeEditorFontSize: '20',
					chatCodeFont: 'departure-mono',
					chatCodeFontSize: '18',
					...(value === undefined
						? {}
						: {
								expandedEditorFont: value,
								expandedEditorFontSize: value,
								chatOutputFont: value,
								chatOutputFontSize: value,
							}),
				}),
			).toMatchObject({
				expandedEditorFont: 'default',
				expandedEditorFontSize: 'default',
				chatOutputFont: 'default',
				chatOutputFontSize: 'default',
			});
		},
	);

	it.each(TYPOGRAPHY_SURFACES)('enforces font eligibility for $id', ({ id, fontKey }) => {
		const mono = ['chat-code', 'code-editor', 'code-diff', 'terminal'].includes(id);
		for (const font of FONT_OPTIONS) {
			const expected =
				mono && ['system-sans', 'system-serif', 'inter'].includes(font) ? 'default' : font;
			expect(parseSurfaceFont(id, font)).toBe(expected);
			expect(parseTypographyPreferences({ [fontKey]: font })[fontKey]).toBe(expected);
		}
	});

	it('applies a font and size together in one storage write without changing another owner', () => {
		const store = createStore();
		const persist = vi.spyOn(localStorage, 'setItem');
		try {
			store.setTypography('expanded-editor', 'inter', '18');
			expect(persist).toHaveBeenCalledTimes(1);
			expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings)!)).toMatchObject({
				expandedEditorFont: 'inter',
				expandedEditorFontSize: '18',
				codeEditorFont: 'default',
				codeEditorFontSize: 'default',
			});
		} finally {
			persist.mockRestore();
		}
	});

	it.each(TYPOGRAPHY_SURFACES)('validates $id independently', ({ fontKey, sizeKey }) => {
		for (const invalid of [null, true, 14, '-1', '100', 'serif', {}, []]) {
			expect(parseTypographyPreferences({ [fontKey]: invalid, [sizeKey]: invalid })).toEqual(
				TYPOGRAPHY_DEFAULTS,
			);
		}
		for (const size of TYPOGRAPHY_SIZE_OPTIONS) {
			expect(
				parseTypographyPreferences({
					...TYPOGRAPHY_DEFAULTS,
					interfaceFontSize: 'default',
					[fontKey]: 'departure-mono',
					[sizeKey]: size,
				}),
			).toEqual({
				...TYPOGRAPHY_DEFAULTS,
				[fontKey]: 'departure-mono',
				[sizeKey]: size,
			});
		}
	});

	it.each(TYPOGRAPHY_SURFACES)(
		'persists and synchronizes $id without changing other surfaces',
		({ fontKey, sizeKey }) => {
			const store = createStore();
			store.set(fontKey, 'departure-mono');
			store.set(sizeKey, '18');
			const restored = createStore();
			expect(restored.snapshot()).toMatchObject({
				...TYPOGRAPHY_DEFAULTS,
				[fontKey]: 'departure-mono',
				[sizeKey]: '18',
			});
			store.set(sizeKey, 'default');
			window.dispatchEvent(
				new StorageEvent('storage', {
					key: LOCAL_STORAGE_KEYS.localSettings,
					storageArea: localStorage,
				}),
			);
			expect(restored[sizeKey]).toBe('default');
			expect(restored[fontKey]).toBe('departure-mono');
			localStorage.clear();
			window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
			expect(restored.snapshot()).toMatchObject(TYPOGRAPHY_DEFAULTS);
		},
	);
});
