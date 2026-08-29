import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalSettingsStore, HIDEABLE_TOOL_GROUPS } from '../local-settings.svelte';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

describe('LocalSettingsStore', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('defaults max chat width and file opening preferences', () => {
		const store = createLocalSettingsStore();

		expect(store.chatListDock).toBe('left');
		expect(store.chatMaxWidth).toBe('none');
		expect(store.overlayBackdropEffects).toBe(true);
		expect(store.alwaysExpandCliMessages).toBe(false);
		expect(store.allowDirectChats).toBe(false);
		expect(store.sidebarGroupByProject).toBe(true);
		expect(store.sidebarGroupNestedProjectPaths).toBe(false);
		expect(store.sidebarChatItemLayout).toBe('default');
		expect(store.sidebarSortMode).toBe('manual');
		expect(store.reduceMotion).toBe(false);
		expect(store.showQuickCommitTray).toBe(true);
		expect(store.textEditorOpenPlacement).toBe('same-window');
		expect(store.imageViewerOpenPlacement).toBe('same-window');
		expect(store.markdownViewerOpenPlacement).toBe('same-window');
		expect(store.terminalFontSize).toBe('13');
		expect(store.hiddenToolTypes).toEqual([]);
		expect(store.steerWithCtrlEnter).toBe(true);

		store.destroy();
	});

	it('persists the CLI message expansion preference', () => {
		const store = createLocalSettingsStore();
		store.toggle('alwaysExpandCliMessages');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ alwaysExpandCliMessages: true });
		const restored = createLocalSettingsStore();
		expect(restored.alwaysExpandCliMessages).toBe(true);

		store.destroy();
		restored.destroy();
	});

	it('persists every chat item layout and defaults malformed values to default', () => {
		const store = createLocalSettingsStore();

		store.set('sidebarChatItemLayout', 'single-line');
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ sidebarChatItemLayout: 'single-line' });

		const restored = createLocalSettingsStore();
		expect(restored.sidebarChatItemLayout).toBe('single-line');
		store.destroy();
		restored.destroy();

		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ sidebarChatItemLayout: 'condensed' }),
		);
		const malformed = createLocalSettingsStore();
		expect(malformed.sidebarChatItemLayout).toBe('default');
		malformed.destroy();
	});

	it('persists Ctrl+Enter steering and defaults malformed values to enabled', () => {
		const store = createLocalSettingsStore();
		store.toggle('steerWithCtrlEnter');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ steerWithCtrlEnter: false });
		const restored = createLocalSettingsStore();
		expect(restored.steerWithCtrlEnter).toBe(false);
		store.destroy();
		restored.destroy();

		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ steerWithCtrlEnter: 'enabled' }),
		);
		const malformed = createLocalSettingsStore();
		expect(malformed.steerWithCtrlEnter).toBe(true);
		malformed.destroy();
	});

	it('persists and restores the chat list dock', () => {
		const store = createLocalSettingsStore();
		store.set('chatListDock', 'right');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({
			chatListDock: 'right',
		});

		const restored = createLocalSettingsStore();
		expect(restored.chatListDock).toBe('right');

		store.destroy();
		restored.destroy();
	});

	it('persists and sanitizes global shortcut overrides', () => {
		const store = createLocalSettingsStore();
		store.set('globalShortcuts', {
			'delete-chat': { key: 'X', ctrl: true },
			'new-chat': null,
		});

		const restored = createLocalSettingsStore();
		expect(restored.globalShortcuts).toEqual({
			'delete-chat': { key: 'x', ctrl: true },
			'new-chat': null,
		});

		store.destroy();
		restored.destroy();
	});

	it('drops malformed persisted global shortcuts', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({
				globalShortcuts: {
					'delete-chat': { key: 'Control', ctrl: true },
					unknown: { key: 'x', ctrl: true },
				},
			}),
		);

		const store = createLocalSettingsStore();
		expect(store.globalShortcuts).toEqual({});
		store.destroy();
	});

	it('copies chat-list dock values between stores and snapshots', () => {
		const first = createLocalSettingsStore();
		const second = createLocalSettingsStore();

		expect(first.chatListDock).toBe(second.chatListDock);

		first.destroy();
		second.destroy();
	});

	it('normalizes malformed chat-list dock values passed to set', () => {
		const store = createLocalSettingsStore();

		store.set('chatListDock', 'middle' as never);

		expect(store.chatListDock).toBe('left');
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

	it('persists direct chat opt-in and rejects malformed persisted values', () => {
		const store = createLocalSettingsStore();
		store.toggle('allowDirectChats');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ allowDirectChats: true });

		const restored = createLocalSettingsStore();
		expect(restored.allowDirectChats).toBe(true);
		restored.destroy();
		store.destroy();

		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ allowDirectChats: 'enabled' }),
		);
		const malformed = createLocalSettingsStore();
		expect(malformed.allowDirectChats).toBe(false);
		malformed.destroy();
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
		store.set('textEditorOpenPlacement', 'new-window');
		store.set('imageViewerOpenPlacement', 'dialog');
		store.set('markdownViewerOpenPlacement', 'same-window');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({
			textEditorOpenPlacement: 'new-window',
			imageViewerOpenPlacement: 'dialog',
			markdownViewerOpenPlacement: 'same-window',
		});

		const restored = createLocalSettingsStore();
		expect(restored.textEditorOpenPlacement).toBe('new-window');
		expect(restored.imageViewerOpenPlacement).toBe('dialog');
		expect(restored.markdownViewerOpenPlacement).toBe('same-window');

		store.destroy();
		restored.destroy();
	});

	it('defaults missing file opening preferences to the same window', () => {
		localStorage.setItem(LOCAL_STORAGE_KEYS.localSettings, JSON.stringify({}));

		const store = createLocalSettingsStore();

		expect(store.textEditorOpenPlacement).toBe('same-window');
		expect(store.imageViewerOpenPlacement).toBe('same-window');
		expect(store.markdownViewerOpenPlacement).toBe('same-window');
		store.destroy();
	});

	it('falls back independently for invalid file opening placements', () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({
				textEditorOpenPlacement: 'floating',
				imageViewerOpenPlacement: 'retired-value',
				markdownViewerOpenPlacement: 42,
			}),
		);

		const store = createLocalSettingsStore();

		expect(store.textEditorOpenPlacement).toBe('same-window');
		expect(store.imageViewerOpenPlacement).toBe('same-window');
		expect(store.markdownViewerOpenPlacement).toBe('same-window');
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
		store.set('sidebarChatItemLayout', 'compact');
		store.set('showQuickCommitTray', false);
		store.toggle('reduceMotion');

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({
			chatMaxWidth: 'medium',
			sidebarGroupByProject: false,
			sidebarGroupNestedProjectPaths: true,
			sidebarChatItemLayout: 'compact',
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
				sidebarChatItemLayout: 'compact',
				showQuickCommitTray: false,
				allowDirectChats: true,
				steerWithCtrlEnter: false,
				chatListDock: 'right',
				textEditorOpenPlacement: 'same-window',
				imageViewerOpenPlacement: 'new-window',
				markdownViewerOpenPlacement: 'same-window',
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
		expect(secondStore.sidebarChatItemLayout).toBe('compact');
		expect(secondStore.showQuickCommitTray).toBe(false);
		expect(secondStore.allowDirectChats).toBe(true);
		expect(secondStore.steerWithCtrlEnter).toBe(false);
		expect(secondStore.chatListDock).toBe('right');
		expect(secondStore.textEditorOpenPlacement).toBe('same-window');
		expect(secondStore.imageViewerOpenPlacement).toBe('new-window');
		expect(secondStore.markdownViewerOpenPlacement).toBe('same-window');

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

	it('defaults the snippet trigger and persists valid values', () => {
		const store = createLocalSettingsStore();
		expect(store.snippetTrigger).toBe(';;');

		store.set('snippetTrigger', '!!');
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ snippetTrigger: '!!' });

		const restored = createLocalSettingsStore();
		expect(restored.snippetTrigger).toBe('!!');

		store.destroy();
		restored.destroy();
	});

	it('coerces invalid snippet triggers on set and on parse', () => {
		const store = createLocalSettingsStore();

		store.set('snippetTrigger', ';');
		expect(store.snippetTrigger).toBe(';;');
		store.set('snippetTrigger', 'ab');
		expect(store.snippetTrigger).toBe(';;');
		store.set('snippetTrigger', ';@');
		expect(store.snippetTrigger).toBe(';;');
		store.set('snippetTrigger', ';;ok');
		expect(store.snippetTrigger).toBe(';;ok');

		store.destroy();

		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ snippetTrigger: 'way-too-long' }),
		);
		const restored = createLocalSettingsStore();
		expect(restored.snippetTrigger).toBe(';;');
		restored.destroy();
	});
});
