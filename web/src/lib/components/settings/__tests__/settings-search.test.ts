import { describe, expect, it } from 'vitest';
import { SETTINGS_TABS } from '$lib/stores/app-shell.svelte';
import { searchSettings, settingsSearchEntries } from '../settings-search';

describe('settings search', () => {
	it('covers all tabs with unique translated entries', () => {
		const entries = settingsSearchEntries();
		expect(new Set(entries.map((entry) => entry.tab))).toEqual(new Set(SETTINGS_TABS));
		expect(new Set(entries.map((entry) => `${entry.tab}:${entry.label}`)).size).toBe(
			entries.length,
		);
	});
	it('matches all query words against setting and section and ignores empty searches', () => {
		const entries = settingsSearchEntries();
		expect(searchSettings(entries, '  COMMIT model ')).toEqual([
			{ tab: 'automation', label: 'Commit message model', section: 'Automation' },
		]);
		expect(searchSettings(entries, 'interface theme').length).toBeGreaterThan(0);
		expect(searchSettings(entries, ' ')).toEqual([]);
		expect(searchSettings(entries, 'not-a-setting')).toEqual([]);
	});
});
