import { beforeEach, describe, expect, it } from 'vitest';
import { createPreferencesStore } from '../preferences.svelte';

describe('PreferencesStore', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('defaults theme to system', () => {
		const store = createPreferencesStore();
		expect(store.theme).toBe('system');
	});

	it('defaults showChatHeader to false', () => {
		const store = createPreferencesStore();
		expect(store.showChatHeader).toBe(false);
	});

	it('defaults alwaysFullscreenOnGitPanel to true', () => {
		const store = createPreferencesStore();
		expect(store.alwaysFullscreenOnGitPanel).toBe(true);
	});

	it('persists showChatHeader through storage', () => {
		const first = createPreferencesStore();
		first.setPreference('showChatHeader', true);

		const second = createPreferencesStore();
		expect(second.showChatHeader).toBe(true);
	});

	it('persists sendByShiftEnter through storage', () => {
		const first = createPreferencesStore();
		first.setPreference('sendByShiftEnter', true);

		const second = createPreferencesStore();
		expect(second.sendByShiftEnter).toBe(true);
	});

	it('persists autoExpandTools through storage', () => {
		const first = createPreferencesStore();
		first.setPreference('autoExpandTools', true);

		const second = createPreferencesStore();
		expect(second.autoExpandTools).toBe(true);
	});

	it('persists alwaysFullscreenOnGitPanel through storage', () => {
		const first = createPreferencesStore();
		first.setPreference('alwaysFullscreenOnGitPanel', false);

		const second = createPreferencesStore();
		expect(second.alwaysFullscreenOnGitPanel).toBe(false);
	});
});
