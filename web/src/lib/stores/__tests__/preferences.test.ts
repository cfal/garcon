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

	it('defaults codeEditorFontSize to 12', () => {
		const store = createPreferencesStore();
		expect(store.codeEditorFontSize).toBe('12');
	});

	it('defaults markdownViewerFontSize to 12', () => {
		const store = createPreferencesStore();
		expect(store.markdownViewerFontSize).toBe('12');
	});

	it('defaults gitDiffFontSize to 12', () => {
		const store = createPreferencesStore();
		expect(store.gitDiffFontSize).toBe('12');
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

	it('persists markdownViewerFontSize through storage', () => {
		const first = createPreferencesStore();
		first.setPreference('markdownViewerFontSize', '16');

		const second = createPreferencesStore();
		expect(second.markdownViewerFontSize).toBe('16');
	});

	it('persists gitDiffFontSize through storage', () => {
		const first = createPreferencesStore();
		first.setPreference('gitDiffFontSize', '16');

		const second = createPreferencesStore();
		expect(second.gitDiffFontSize).toBe('16');
	});
});
