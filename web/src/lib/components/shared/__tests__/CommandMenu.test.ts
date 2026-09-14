import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
import { WorkbenchCommandRegistry } from '$lib/workspace/workbench-commands.svelte.js';
import type { WorkbenchCommandRegistryDeps } from '$lib/workspace/workbench-commands.svelte.js';
import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import type { FilesSurfaceController } from '$lib/workspace/singleton-surfaces.svelte.js';
import { FileNavigationStore } from '$lib/files/navigation/file-navigation-store.svelte.js';
import { createMemoryFileDraftRepository } from '$lib/files/persistence/file-draft-repository.js';

type CommandMenuWorkspacePort = Pick<
	WorkspaceCoordinator,
	| 'isMobile'
	| 'focusOwner'
	| 'focusChat'
	| 'openSingleton'
	| 'focusMostRecentTerminalOrCreate'
	| 'createTerminalInAvailableSpace'
>;

const mocks = vi.hoisted(() => ({
	workspace: {
		isMobile: false as boolean,
		focusOwner: { kind: 'chat-list' },
		focusChat: vi.fn(),
		openSingleton: vi.fn(async () => undefined),
		focusMostRecentTerminalOrCreate: vi.fn(async () => undefined),
		createTerminalInAvailableSpace: vi.fn(async () => 'terminal-new'),
	} satisfies CommandMenuWorkspacePort,
	appShell: {
		openNewChatDialog: vi.fn(),
		openSettings: vi.fn(),
	},
	ghCapability: {
		available: true,
		hasChecked: true,
	},
	notifications: {
		error: vi.fn(),
	},
	transientLayers: {
		open: (_modality: string, action: () => void) => action(),
		register: () => () => undefined,
	},
}));

vi.mock('$lib/context', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/context')>()),
	getWorkbenchCommands: () => commandRegistry,
	getTransientLayers: () => mocks.transientLayers,
}));

import CommandMenu from '../CommandMenu.svelte';

const workspace: CommandMenuWorkspacePort = mocks.workspace;
const terminals: Pick<WorkbenchCommandRegistryDeps['terminals'], 'listStatus' | 'orderedSessions'> =
	{
		listStatus: 'ready',
		orderedSessions: [],
	};
const appShell: Pick<
	WorkbenchCommandRegistryDeps['appShell'],
	'openNewChatDialog' | 'openSettings'
> = mocks.appShell;
const ghCapability: Pick<WorkbenchCommandRegistryDeps['ghCapability'], 'available' | 'hasChecked'> =
	mocks.ghCapability;
const files: Pick<WorkbenchCommandRegistryDeps['files'], 'navigation' | 'open'> = {
	navigation: null,
	open: vi.fn(async () => null),
};
let knownFiles: FileTreeStore['knownFiles'] = [];
let fileRootPath: string | null = null;
const tree: Pick<FileTreeStore, 'knownFiles' | 'fileRootPath'> = {
	get knownFiles() {
		return knownFiles;
	},
	get fileRootPath() {
		return fileRootPath;
	},
};
const filesSurface: Pick<FilesSurfaceController, 'tree'> = { tree: tree as FileTreeStore };
const commandRegistry = new WorkbenchCommandRegistry({
	workspace: workspace as WorkbenchCommandRegistryDeps['workspace'],
	terminals: terminals as WorkbenchCommandRegistryDeps['terminals'],
	appShell: appShell as WorkbenchCommandRegistryDeps['appShell'],
	ghCapability: ghCapability as WorkbenchCommandRegistryDeps['ghCapability'],
	files: files as WorkbenchCommandRegistryDeps['files'],
	filesSurface: () => filesSurface as FilesSurfaceController,
	filesSurfaceIfPresent: () => filesSurface as FilesSurfaceController,
	onError: mocks.notifications.error,
	onInfo: vi.fn(),
});

afterEach(() => {
	cleanup();
	mocks.workspace.isMobile = false;
	files.navigation = null;
	knownFiles = [];
	fileRootPath = null;
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('CommandMenu', () => {
	it('refreshes known files on reopening without requiring reactive controller creation', async () => {
		const { component } = render(CommandMenu);
		component.toggle();
		await screen.findByRole('dialog');
		component.toggle();
		await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		fileRootPath = '/workspace';
		knownFiles = [
			{
				name: 'later.ts',
				path: '/workspace/later.ts',
				relativePath: 'later.ts',
				type: 'file',
				size: 0,
				modified: null,
				permissionsRwx: 'rw-r--r--',
			},
		];

		component.toggle();

		expect(
			await screen.findByRole('option', { name: 'Open later.ts Known file File' }),
		).toBeTruthy();
	});

	it('routes execution failures through the workbench registry', async () => {
		const error = new Error('Could not open Files');
		mocks.workspace.openSingleton.mockRejectedValueOnce(error);
		const { component } = render(CommandMenu);
		component.toggle();

		await fireEvent.click(await screen.findByText(m.command_switch_to_files()));

		expect(mocks.notifications.error).toHaveBeenCalledWith(error);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('deduplicates known files against recents and opens the retained location', async () => {
		const fileName = 'file "with spaces".ts';
		fileRootPath = '/workspace';
		knownFiles = [
			{
				name: fileName,
				path: `/workspace/${fileName}`,
				relativePath: fileName,
				type: 'file',
				size: 0,
				modified: null,
				permissionsRwx: 'rw-r--r--',
			},
		];
		files.navigation = new FileNavigationStore(createMemoryFileDraftRepository(), {
			userNamespace: 'test-user',
			deploymentId: 'test-deployment',
		});
		files.navigation.recents = [
			{
				key: JSON.stringify(['/workspace', fileName]),
				canonicalFileRootPath: '/workspace',
				normalizedRelativePath: fileName,
				displayPath: fileName,
				revision: null,
				line: 7,
				column: 3,
				viewPreference: 'source',
				timestamp: 1,
			},
		];
		const { component } = render(CommandMenu);
		component.toggle();
		const name = `Open ${fileName} Known file File`;
		const option = await screen.findByRole('option', { name });
		expect(screen.getAllByRole('option', { name })).toHaveLength(1);
		expect(option.id).not.toMatch(/\s/);
		await fireEvent.mouseEnter(option);
		const activeId = screen.getByRole('combobox').getAttribute('aria-activedescendant');
		expect(document.getElementById(activeId!)).toBe(option);

		await fireEvent.click(option);

		expect(files.open).toHaveBeenCalledWith({
			fileRootPath: '/workspace',
			relativePath: fileName,
			mode: 'code',
			origin: 'window-main',
			reason: 'user-open',
			line: 7,
			col: 3,
		});
	});

	it('reports failed known-file placement through the registry error boundary', async () => {
		const error = new Error('File surface was not placed');
		vi.spyOn(commandRegistry, 'knownFileLocations', 'get').mockReturnValue([
			{
				key: '["/workspace","file.ts"]',
				canonicalFileRootPath: '/workspace',
				normalizedRelativePath: 'file.ts',
				displayPath: 'file.ts',
				revision: null,
				line: 1,
				column: 1,
				viewPreference: 'source',
				timestamp: 1,
			},
		]);
		vi.spyOn(commandRegistry, 'openLocation').mockRejectedValueOnce(error);
		const { component } = render(CommandMenu);
		component.toggle();

		await fireEvent.click(
			await screen.findByRole('option', { name: 'Open file.ts Known file File' }),
		);

		expect(mocks.notifications.error).toHaveBeenCalledWith(error);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('exposes the keyboard-highlighted option through combobox semantics', async () => {
		const { component } = render(CommandMenu);
		component.toggle();

		const input = await screen.findByRole('combobox');
		const listbox = screen.getByRole('listbox');
		const options = screen.getAllByRole('option');

		expect(input.getAttribute('aria-controls')).toBe(listbox.id);
		expect(input.getAttribute('aria-expanded')).toBe('true');
		expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);

		await fireEvent.keyDown(input, { key: 'ArrowDown' });

		expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
		expect(options[1]?.getAttribute('aria-selected')).toBe('true');
	});

	it('clears the active descendant when filtering returns no commands', async () => {
		const { component } = render(CommandMenu);
		component.toggle();

		const input = await screen.findByRole('combobox');
		await fireEvent.input(input, { target: { value: 'no matching command exists' } });

		expect(input.hasAttribute('aria-activedescendant')).toBe(false);
		expect(screen.queryByRole('option')).toBeNull();
	});

	it('does not execute the highlighted command while Enter commits IME composition', async () => {
		const { component } = render(CommandMenu);
		component.toggle();
		const input = await screen.findByRole('combobox');

		await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

		expect(mocks.appShell.openNewChatDialog).not.toHaveBeenCalled();
		expect(input.getAttribute('aria-expanded')).toBe('true');
	});

	it.each([
		['History', 'git-history'],
		['Compare', 'git-compare'],
		['Open Chat Map', 'chat-map'],
		['Open Canvas', 'chat-canvas'],
		['Open Chat Board', 'chat-board'],
	] as const)('opens standalone %s through generic desktop placement', async (label, kind) => {
		const { component } = render(CommandMenu);
		component.toggle();

		await fireEvent.click(await screen.findByText(label));
		expect(mocks.workspace.openSingleton).toHaveBeenCalledWith(kind);
	});

	it.each([
		['History', 'git-history'],
		['Compare', 'git-compare'],
		['Open Chat Map', 'chat-map'],
		['Open Canvas', 'chat-canvas'],
		['Open Chat Board', 'chat-board'],
	] as const)('focuses standalone %s on mobile', async (label, kind) => {
		mocks.workspace.isMobile = true;
		const { component } = render(CommandMenu);
		component.toggle();

		await fireEvent.click(await screen.findByText(label));
		expect(mocks.workspace.openSingleton).toHaveBeenCalledWith(kind);
	});

	it('creates a new terminal using available workspace space', async () => {
		const { component } = render(CommandMenu);
		component.toggle();

		await fireEvent.click(await screen.findByText(m.workspace_new_terminal()));
		expect(mocks.workspace.createTerminalInAvailableSpace).toHaveBeenCalledWith(
			'command-menu:new-terminal',
		);
	});

	it('focuses the most recent terminal without a legacy host argument', async () => {
		const { component } = render(CommandMenu);
		component.toggle();

		await fireEvent.click(await screen.findByText(m.command_switch_to_terminal()));
		expect(mocks.workspace.focusMostRecentTerminalOrCreate).toHaveBeenCalledWith();
	});
});
