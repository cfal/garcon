import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
	typographyScale,
	readTypographyScale,
} from '../typography';

describe('scoped typography preferences', () => {
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

	it('preserves renderer defaults from older full settings snapshots', () => {
		const legacy = { codeEditorFontSize: '12', gitDiffFontSize: '12', terminalFontSize: '13' };
		expect(parseTypographyPreferences(legacy)).toEqual(TYPOGRAPHY_DEFAULTS);
		expect(legacy).toEqual({
			codeEditorFontSize: '12',
			gitDiffFontSize: '12',
			terminalFontSize: '13',
		});
		expect(parseTypographyPreferences({ ...legacy, chatCodeFontSize: '12' })).toEqual({
			...TYPOGRAPHY_DEFAULTS,
			chatCodeFontSize: '12',
		});
		expect(parseTypographyPreferences({ ...legacy, gitDiffFontSize: '18' }).gitDiffFontSize).toBe(
			'18',
		);
		expect(parseTypographyPreferences({ ...legacy, interfaceFontSize: 'default' })).toMatchObject(
			legacy,
		);
		expect(parseTypographyPreferences({ ...legacy, interfaceFontSize: null })).toMatchObject(
			legacy,
		);
		localStorage.setItem(LOCAL_STORAGE_KEYS.localSettings, JSON.stringify(legacy));
		const store = createStore();
		store.set('gitDiffFontSize', '12');
		expect(createStore().gitDiffFontSize).toBe('12');
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
