import { describe, expect, it } from 'vitest';
import { SETTINGS_TABS } from '$lib/stores/app-shell.svelte';
import { TYPOGRAPHY_SURFACES, type TypographySurface } from '$lib/theme/typography.js';
import { searchSettings, settingsSearchEntries } from '../settings-search';

describe('settings search', () => {
	const surfaceLabels: Record<TypographySurface, string> = {
		interface: 'Interface',
		'chat-list': 'Chat List',
		'chat-feed': 'Chat Feed',
		'chat-code': 'Chat Code & Commands',
		'chat-output': 'Plain Tool Output',
		'code-editor': 'File Editors',
		'expanded-editor': 'Expanded Text Editors',
		'code-diff': 'Code Diffs',
		terminal: 'Terminal',
	};

	it.each(TYPOGRAPHY_SURFACES)('lists separate font and size controls for $id', ({ id }) => {
		const surfaceLabel = surfaceLabels[id];
		const results = searchSettings(settingsSearchEntries(), `${surfaceLabel} font`);
		expect(results).toEqual([
			{ tab: 'appearance', label: `${surfaceLabel} Font`, section: 'Appearance' },
			{ tab: 'appearance', label: `${surfaceLabel} Font Size`, section: 'Appearance' },
		]);
	});
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
		expect(searchSettings(entries, 'appearance theme').length).toBeGreaterThan(0);
		expect(searchSettings(entries, 'image cache')).toEqual([
			{ tab: 'behavior', label: 'Inline image cache size', section: 'Behavior' },
		]);
		expect(searchSettings(entries, 'Mermaid')).toEqual([
			{ tab: 'appearance', label: 'Inline Mermaid thumbnail size (px)', section: 'Appearance' },
		]);
		expect(searchSettings(entries, 'message format')).toEqual([
			{ tab: 'behavior', label: 'Message format', section: 'Behavior' },
		]);
		expect(searchSettings(entries, 'paste key')).toEqual([
			{ tab: 'providers', label: 'Paste an API key', section: 'Providers' },
		]);
		expect(searchSettings(entries, ' ')).toEqual([]);
		expect(searchSettings(entries, 'not-a-setting')).toEqual([]);
	});
});
