import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';

type CommandMenuWorkspacePort = Pick<
	WorkspaceCoordinator,
	| 'isMobile'
	| 'focusChat'
	| 'focusMobileSingleton'
	| 'openSingletonInNewWindow'
	| 'focusMostRecentTerminalOrCreate'
	| 'createTerminalInNewWindow'
>;

const mocks = vi.hoisted(() => ({
	workspace: {
		isMobile: false as boolean,
		focusChat: vi.fn(),
		focusMobileSingleton: vi.fn(),
		openSingletonInNewWindow: vi.fn(async () => undefined),
		focusMostRecentTerminalOrCreate: vi.fn(async () => undefined),
		createTerminalInNewWindow: vi.fn(async () => 'terminal-new'),
	} satisfies CommandMenuWorkspacePort,
	terminals: {
		listStatus: 'ready',
		orderedSessions: [],
	},
	appShell: {
		openNewChatDialog: vi.fn(),
		openSettings: vi.fn(),
	},
	localSettings: {
		colorblindMode: false,
		toggle: vi.fn(),
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
	getWorkspaceCoordinator: () => mocks.workspace,
	getTerminalRegistry: () => mocks.terminals,
	getAppShell: () => mocks.appShell,
	getLocalSettings: () => mocks.localSettings,
	getGhCapability: () => mocks.ghCapability,
	getNotifications: () => mocks.notifications,
	getTransientLayers: () => mocks.transientLayers,
}));

import CommandMenu from '../CommandMenu.svelte';

afterEach(() => {
	cleanup();
	mocks.workspace.isMobile = false;
	vi.clearAllMocks();
});

describe('CommandMenu', () => {
	it.each([
		['History', 'git-history'],
		['Compare', 'git-compare'],
		['Work Map', 'work-map'],
	] as const)('opens standalone %s in a new desktop window', async (label, kind) => {
		const { component } = render(CommandMenu);
		component.toggle();

		await fireEvent.click(await screen.findByText(label));
		expect(mocks.workspace.openSingletonInNewWindow).toHaveBeenCalledWith(kind);
	});

	it.each([
		['History', 'git-history'],
		['Compare', 'git-compare'],
		['Work Map', 'work-map'],
	] as const)('focuses standalone %s on mobile', async (label, kind) => {
		mocks.workspace.isMobile = true;
		const { component } = render(CommandMenu);
		component.toggle();

		await fireEvent.click(await screen.findByText(label));
		expect(mocks.workspace.focusMobileSingleton).toHaveBeenCalledWith(kind);
	});

	it('creates a new terminal in a new window', async () => {
		const { component } = render(CommandMenu);
		component.toggle();

		await fireEvent.click(await screen.findByText(m.workspace_new_terminal()));
		expect(mocks.workspace.createTerminalInNewWindow).toHaveBeenCalledWith(
			undefined,
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
