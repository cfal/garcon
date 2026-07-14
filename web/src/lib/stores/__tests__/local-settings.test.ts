import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalSettingsStore, HIDEABLE_TOOL_GROUPS } from '../local-settings.svelte';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

describe('LocalSettingsStore', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('defaults max chat width to none', () => {
		const store = createLocalSettingsStore();

		expect(store.chatMaxWidth).toBe('none');
		expect(store.sidebarGroupByProject).toBe(true);
		expect(store.sidebarGroupNestedProjectPaths).toBe(false);
		expect(store.sidebarCompactChatItems).toBe(false);
		expect(store.sidebarSortMode).toBe('manual');
		expect(store.showQuickCommitTray).toBe(true);
		expect(store.textEditorOpenPlacement).toBe('dialog');
		expect(store.imageViewerOpenPlacement).toBe('dialog');
		expect(store.markdownViewerOpenPlacement).toBe('dialog');
		expect(store.terminalFontSize).toBe('13');
		expect(store.hiddenToolTypes).toEqual([]);

		store.destroy();
	});

	it('persists the terminal font size', () => {
		const store = createLocalSettingsStore();
		store.set('terminalFontSize', '18');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ terminalFontSize: '18' });

		const restored = createLocalSettingsStore();
		expect(restored.terminalFontSize).toBe('18');

		store.destroy();
		restored.destroy();
	});

	it('persists independent file opening placements', () => {
		const store = createLocalSettingsStore();
		store.set('textEditorOpenPlacement', 'main');
		store.set('imageViewerOpenPlacement', 'sidebar');
		store.set('markdownViewerOpenPlacement', 'dialog');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({
			textEditorOpenPlacement: 'main',
			imageViewerOpenPlacement: 'sidebar',
			markdownViewerOpenPlacement: 'dialog',
		});

		const restored = createLocalSettingsStore();
		expect(restored.textEditorOpenPlacement).toBe('main');
		expect(restored.imageViewerOpenPlacement).toBe('sidebar');
		expect(restored.markdownViewerOpenPlacement).toBe('dialog');

		store.destroy();
		restored.destroy();
	});

	it('falls back independently for invalid file opening placements', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({
				textEditorOpenPlacement: 'floating',
				imageViewerOpenPlacement: 'sidebar',
				markdownViewerOpenPlacement: 42,
			}),
		);

		const store = createLocalSettingsStore();

		expect(store.textEditorOpenPlacement).toBe('dialog');
		expect(store.imageViewerOpenPlacement).toBe('sidebar');
		expect(store.markdownViewerOpenPlacement).toBe('dialog');
		store.destroy();
	});

	it('persists hidden tool groups', () => {
		const store = createLocalSettingsStore();
		const commands = HIDEABLE_TOOL_GROUPS.find((group) => group.id === 'commands');
		if (!commands) throw new Error('expected command tool group');
		store.setToolTypesHidden(commands.toolTypes, true);

		expect(store.areToolTypesHidden(commands.toolTypes)).toBe(true);
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ hiddenToolTypes: commands.toolTypes });

		const restored = createLocalSettingsStore();
		expect(restored.areToolTypesHidden(commands.toolTypes)).toBe(true);
		restored.setToolTypesHidden(commands.toolTypes, false);
		expect(restored.hiddenToolTypes).toEqual([]);

		store.destroy();
		restored.destroy();
	});

	it('normalizes partial families and drops unsupported persisted tool types', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ hiddenToolTypes: ['bash-tool-use', 'unknown-tool-use', 'bash-tool-use'] }),
		);

		const store = createLocalSettingsStore();

		const commands = HIDEABLE_TOOL_GROUPS.find((group) => group.id === 'commands');
		if (!commands) throw new Error('expected command tool group');
		expect(store.hiddenToolTypes).toEqual(commands.toolTypes);
		expect(store.areToolTypesHidden(commands.toolTypes)).toBe(true);
		store.destroy();
	});

	it('drops persisted hidden tool selections with no supported family member', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ hiddenToolTypes: ['unknown-tool-use', null, 42] }),
		);

		const store = createLocalSettingsStore();

		expect(store.hiddenToolTypes).toEqual([]);
		store.destroy();
	});

	it('keeps family selections complete when hidden tool types are set directly', () => {
		const store = createLocalSettingsStore();
		const fileReads = HIDEABLE_TOOL_GROUPS.find((group) => group.id === 'file-reads');
		if (!fileReads) throw new Error('expected file read tool group');

		store.set('hiddenToolTypes', ['grep-tool-use']);

		expect(store.hiddenToolTypes).toEqual(fileReads.toolTypes);
		expect(store.areToolTypesHidden(fileReads.toolTypes)).toBe(true);
		store.destroy();
	});

	it('persists and restores the sidebar sort mode', () => {
		const store = createLocalSettingsStore();
		store.set('sidebarSortMode', 'recent');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ sidebarSortMode: 'recent' });

		const restored = createLocalSettingsStore();
		expect(restored.sidebarSortMode).toBe('recent');

		store.destroy();
		restored.destroy();
	});

	it('falls back to manual for invalid sidebar sort mode', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ sidebarSortMode: 'chronological' }),
		);

		const store = createLocalSettingsStore();

		expect(store.sidebarSortMode).toBe('manual');

		store.destroy();
	});

	it('persists max chat width', () => {
		const store = createLocalSettingsStore();

		store.set('chatMaxWidth', 'medium');
		store.set('sidebarGroupByProject', false);
		store.set('sidebarGroupNestedProjectPaths', true);
		store.set('sidebarCompactChatItems', true);
		store.set('showQuickCommitTray', false);

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({
			chatMaxWidth: 'medium',
			sidebarGroupByProject: false,
			sidebarGroupNestedProjectPaths: true,
			sidebarCompactChatItems: true,
			showQuickCommitTray: false,
		});

		store.destroy();
	});

	it('syncs max chat width across storage events', () => {
		const firstStore = createLocalSettingsStore();
		const secondStore = createLocalSettingsStore();

		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({
				...firstStore.snapshot(),
				chatMaxWidth: 'small',
				sidebarGroupByProject: true,
				sidebarGroupNestedProjectPaths: true,
				sidebarCompactChatItems: true,
				showQuickCommitTray: false,
				textEditorOpenPlacement: 'main',
				imageViewerOpenPlacement: 'sidebar',
				markdownViewerOpenPlacement: 'main',
			}),
		);
		window.dispatchEvent(
			new StorageEvent('storage', {
				key: LOCAL_STORAGE_KEYS.localSettings,
				newValue: localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings),
			}),
		);

		expect(secondStore.chatMaxWidth).toBe('small');
		expect(secondStore.sidebarGroupByProject).toBe(true);
		expect(secondStore.sidebarGroupNestedProjectPaths).toBe(true);
		expect(secondStore.sidebarCompactChatItems).toBe(true);
		expect(secondStore.showQuickCommitTray).toBe(false);
		expect(secondStore.textEditorOpenPlacement).toBe('main');
		expect(secondStore.imageViewerOpenPlacement).toBe('sidebar');
		expect(secondStore.markdownViewerOpenPlacement).toBe('main');

		firstStore.destroy();
		secondStore.destroy();
	});

	it('falls back to default for invalid nested project grouping setting', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({
				sidebarGroupNestedProjectPaths: 'yes',
			}),
		);

		const store = createLocalSettingsStore();

		expect(store.sidebarGroupNestedProjectPaths).toBe(false);

		store.destroy();
	});
});
