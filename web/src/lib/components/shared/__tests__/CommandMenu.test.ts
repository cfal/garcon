import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

const mocks = vi.hoisted(() => ({
	workspace: {
		isMobile: false,
		focusChat: vi.fn(),
		focusMobileSingleton: vi.fn(),
		openSingleton: vi.fn(),
		focusMostRecentTerminalOrCreate: vi.fn(async () => undefined),
		createTerminal: vi.fn(async () => undefined),
	},
	terminals: {
		listStatus: 'ready',
		orderedSessions: [],
	},
	files: {
		showOpenFiles: vi.fn(),
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
	getFileSessions: () => mocks.files,
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
	it('offers File Sessions on desktop', async () => {
		const { component } = render(CommandMenu);
		component.toggle();

		expect(await screen.findByText(m.file_session_open_files())).toBeTruthy();
	});

	it('hides File Sessions on mobile', async () => {
		mocks.workspace.isMobile = true;
		const { component } = render(CommandMenu);
		component.toggle();

		await screen.findByRole('dialog');
		expect(screen.queryByText(m.file_session_open_files())).toBeNull();
	});
});
