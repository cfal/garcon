import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalSettingsStore, HIDEABLE_TOOL_GROUPS } from '../local-settings.svelte';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

describe('LocalSettingsStore', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('defaults max chat width and file opening preferences', () => {
		const store = createLocalSettingsStore();

		expect(store.desktopLayoutOrder).toEqual(['chat-list', 'main', 'workspace-sidebar']);
		expect(store.chatMaxWidth).toBe('none');
		expect(store.overlayBackdropEffects).toBe(true);
		expect(store.sidebarGroupByProject).toBe(true);
		expect(store.sidebarGroupNestedProjectPaths).toBe(false);
		expect(store.sidebarCompactChatItems).toBe(false);
		expect(store.sidebarSortMode).toBe('manual');
		expect(store.reduceMotion).toBe(false);
		expect(store.showQuickCommitTray).toBe(true);
		expect(store.textEditorOpenPlacement).toBe('source');
		expect(store.imageViewerOpenPlacement).toBe('source');
		expect(store.markdownViewerOpenPlacement).toBe('source');
		expect(store.terminalFontSize).toBe('13');
		expect(store.hiddenToolTypes).toEqual([]);

		store.destroy();
	});

	it('persists and restores the desktop layout order', () => {
		const store = createLocalSettingsStore();
		store.set('desktopLayoutOrder', ['workspace-sidebar', 'chat-list', 'main']);

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({
			desktopLayoutOrder: ['workspace-sidebar', 'chat-list', 'main'],
		});

		const restored = createLocalSettingsStore();
		expect(restored.desktopLayoutOrder).toEqual(['workspace-sidebar', 'chat-list', 'main']);

		store.destroy();
		restored.destroy();
	});

	it.each([
		['chat-list', 'main'],
		['chat-list', 'main', 'main'],
		['chat-list', 'main', 'unknown'],
		'chat-list,main,workspace-sidebar',
	])('falls back atomically for malformed desktop layout order %j', (desktopLayoutOrder) => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ desktopLayoutOrder }),
		);

		const store = createLocalSettingsStore();

		expect(store.desktopLayoutOrder).toEqual(['chat-list', 'main', 'workspace-sidebar']);
		store.destroy();
	});

	it('copies desktop layout arrays between stores and snapshots', () => {
		const first = createLocalSettingsStore();
		const second = createLocalSettingsStore();

		expect(first.desktopLayoutOrder).not.toBe(second.desktopLayoutOrder);
		expect(first.snapshot().desktopLayoutOrder).not.toBe(first.desktopLayoutOrder);

		first.destroy();
		second.destroy();
	});

	it('normalizes malformed desktop layout orders passed to set', () => {
		const store = createLocalSettingsStore();

		store.set('desktopLayoutOrder', ['main', 'main', 'chat-list']);

		expect(store.desktopLayoutOrder).toEqual(['chat-list', 'main', 'workspace-sidebar']);
		store.destroy();
	});

	it('persists and restores disabled overlay backdrop effects', () => {
		const store = createLocalSettingsStore();
		store.set('overlayBackdropEffects', false);

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ overlayBackdropEffects: false });

		const restored = createLocalSettingsStore();
		expect(restored.overlayBackdropEffects).toBe(false);

		store.destroy();
		restored.destroy();
	});

	it('defaults malformed overlay backdrop effects to enabled', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ overlayBackdropEffects: 'disabled' }),
		);

		const store = createLocalSettingsStore();

		expect(store.overlayBackdropEffects).toBe(true);
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

	it('falls back to a valid terminal font size for malformed persisted settings', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ terminalFontSize: '-1' }),
		);

		const store = createLocalSettingsStore();

		expect(store.terminalFontSize).toBe('13');
		store.destroy();
	});

	it('persists and restores independent file opening preferences', () => {
		const store = createLocalSettingsStore();
		store.set('textEditorOpenPlacement', 'source');
		store.set('imageViewerOpenPlacement', 'sidebar');
		store.set('markdownViewerOpenPlacement', 'dialog');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({
			textEditorOpenPlacement: 'source',
			imageViewerOpenPlacement: 'sidebar',
			markdownViewerOpenPlacement: 'dialog',
		});

		const restored = createLocalSettingsStore();
		expect(restored.textEditorOpenPlacement).toBe('source');
		expect(restored.imageViewerOpenPlacement).toBe('sidebar');
		expect(restored.markdownViewerOpenPlacement).toBe('dialog');

		store.destroy();
		restored.destroy();
	});

	it('preserves valid legacy fixed placement values', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({
				textEditorOpenPlacement: 'main',
				imageViewerOpenPlacement: 'sidebar',
				markdownViewerOpenPlacement: 'dialog',
			}),
		);

		const store = createLocalSettingsStore();

		expect(store.textEditorOpenPlacement).toBe('main');
		expect(store.imageViewerOpenPlacement).toBe('sidebar');
		expect(store.markdownViewerOpenPlacement).toBe('dialog');
		store.destroy();
	});

	it('defaults missing file opening preferences to source', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ imageViewerOpenPlacement: 'main' }),
		);

		const store = createLocalSettingsStore();

		expect(store.textEditorOpenPlacement).toBe('source');
		expect(store.imageViewerOpenPlacement).toBe('main');
		expect(store.markdownViewerOpenPlacement).toBe('source');
		store.destroy();
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

		expect(store.textEditorOpenPlacement).toBe('source');
		expect(store.imageViewerOpenPlacement).toBe('sidebar');
		expect(store.markdownViewerOpenPlacement).toBe('source');
		store.destroy();
	});

	it('persists hidden tool groups', () => {
		const store = createLocalSettingsStore();
		const bash = HIDEABLE_TOOL_GROUPS.find((group) => group.id === 'bash');
		if (!bash) throw new Error('expected Bash tool group');
		store.setToolTypesHidden(bash.toolTypes, true);

		expect(store.areToolTypesHidden(bash.toolTypes)).toBe(true);
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ hiddenToolTypes: bash.toolTypes });

		const restored = createLocalSettingsStore();
		expect(restored.areToolTypesHidden(bash.toolTypes)).toBe(true);
		restored.setToolTypesHidden(bash.toolTypes, false);
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

		const bash = HIDEABLE_TOOL_GROUPS.find((group) => group.id === 'bash');
		if (!bash) throw new Error('expected Bash tool group');
		expect(store.hiddenToolTypes).toEqual(bash.toolTypes);
		expect(store.areToolTypesHidden(bash.toolTypes)).toBe(true);
		store.destroy();
	});

	it('keeps Bash and Exec visibility independent', () => {
		const store = createLocalSettingsStore();
		const bash = HIDEABLE_TOOL_GROUPS.find((group) => group.id === 'bash');
		const exec = HIDEABLE_TOOL_GROUPS.find((group) => group.id === 'exec');
		if (!bash || !exec) throw new Error('expected Bash and Exec tool groups');

		store.setToolTypesHidden(bash.toolTypes, true);

		expect(store.hiddenToolTypes).toEqual(bash.toolTypes);
		expect(store.areToolTypesHidden(bash.toolTypes)).toBe(true);
		expect(store.areToolTypesHidden(exec.toolTypes)).toBe(false);

		store.setToolTypesHidden(exec.toolTypes, true);
		store.setToolTypesHidden(bash.toolTypes, false);

		expect(store.hiddenToolTypes).toEqual(exec.toolTypes);
		expect(store.areToolTypesHidden(bash.toolTypes)).toBe(false);
		expect(store.areToolTypesHidden(exec.toolTypes)).toBe(true);
		store.destroy();
	});

	it('preserves legacy combined command selections across the split', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({
				hiddenToolTypes: [
					'bash-tool-use',
					'exec-tool-use',
					'wait-tool-use',
					'write-stdin-tool-use',
				],
			}),
		);

		const store = createLocalSettingsStore();
		const bash = HIDEABLE_TOOL_GROUPS.find((group) => group.id === 'bash');
		const exec = HIDEABLE_TOOL_GROUPS.find((group) => group.id === 'exec');
		if (!bash || !exec) throw new Error('expected Bash and Exec tool groups');

		expect(store.areToolTypesHidden(bash.toolTypes)).toBe(true);
		expect(store.areToolTypesHidden(exec.toolTypes)).toBe(true);
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
		store.toggle('reduceMotion');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({
			chatMaxWidth: 'medium',
			sidebarGroupByProject: false,
			sidebarGroupNestedProjectPaths: true,
			sidebarCompactChatItems: true,
			showQuickCommitTray: false,
			reduceMotion: true,
		});

		const restored = createLocalSettingsStore();
		expect(restored.reduceMotion).toBe(true);
		restored.destroy();

		store.destroy();
	});

	it('syncs settings across storage events', () => {
		const firstStore = createLocalSettingsStore();
		const secondStore = createLocalSettingsStore();

		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({
				...firstStore.snapshot(),
				chatMaxWidth: 'small',
				overlayBackdropEffects: false,
				sidebarGroupByProject: true,
				sidebarGroupNestedProjectPaths: true,
				sidebarCompactChatItems: true,
				showQuickCommitTray: false,
				desktopLayoutOrder: ['main', 'workspace-sidebar', 'chat-list'],
				textEditorOpenPlacement: 'source',
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
		expect(secondStore.overlayBackdropEffects).toBe(false);
		expect(secondStore.sidebarGroupByProject).toBe(true);
		expect(secondStore.sidebarGroupNestedProjectPaths).toBe(true);
		expect(secondStore.sidebarCompactChatItems).toBe(true);
		expect(secondStore.showQuickCommitTray).toBe(false);
		expect(secondStore.desktopLayoutOrder).toEqual([
			'main',
			'workspace-sidebar',
			'chat-list',
		]);
		expect(secondStore.textEditorOpenPlacement).toBe('source');
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
