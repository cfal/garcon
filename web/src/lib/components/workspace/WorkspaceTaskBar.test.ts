import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceTaskBar from './WorkspaceTaskBar.svelte';
import * as m from '$lib/paraglide/messages.js';

const { surfaces, moveSurface, popOutFile, closeSurface, showOpenFiles } = vi.hoisted(() => ({
	surfaces: {
		'singleton:chat': { id: 'singleton:chat', type: 'singleton', kind: 'chat' },
		'singleton:git': { id: 'singleton:git', type: 'singleton', kind: 'git' },
		'singleton:files': { id: 'singleton:files', type: 'singleton', kind: 'files' },
		'file:one': { id: 'file:one', type: 'file', fileSessionId: 'one' },
	} as Record<string, { id: string; type: string; kind?: string; fileSessionId?: string }>,
	moveSurface: vi.fn(async () => true),
	popOutFile: vi.fn(async () => true),
	closeSurface: vi.fn(async () => true),
	showOpenFiles: vi.fn(),
}));

vi.mock('$lib/context', () => ({
	getWorkspaceCoordinator: () => ({
		layout: {
			surface: (surfaceId: string) => surfaces[surfaceId] ?? null,
		},
		moveSurface,
		popOutFile,
		closeSurface,
		isSurfaceCloseBlocked: () => false,
		openSingleton: vi.fn(),
		createTerminal: vi.fn(),
	}),
	getTerminalRegistry: () => ({ orderedSessions: [], listStatus: 'ready' }),
	getGhCapability: () => ({ hasChecked: true, available: true }),
	getNotifications: () => ({ error: vi.fn() }),
	getFileSessions: () => ({ showOpenFiles }),
	getOptionalTransientLayers: () => null,
}));

describe('WorkspaceTaskBar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('ResizeObserver', undefined);
		vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
	});

	afterEach(async () => {
		cleanup();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await new Promise((resolve) => window.setTimeout(resolve, 30));
	});

	it('puts active-tab operations at the top of the taskbar menu', async () => {
		render(WorkspaceTaskBar, {
			host: 'main',
			hostState: {
				order: ['singleton:chat', 'singleton:git', 'file:one'],
				activeId: 'singleton:git',
				mru: ['singleton:git', 'singleton:chat'],
			},
			labelFor: (surfaceId: string) =>
				surfaceId === 'singleton:chat' ? 'Chat' : surfaceId === 'singleton:git' ? 'Git' : 'one.ts',
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		const items = screen.getAllByRole('menuitem');
		const moveItem = screen.getByRole('menuitem', { name: m.workspace_move_to_sidebar() });
		const closeItem = screen.getByRole('menuitem', { name: m.workspace_close_tab() });
		const newTerminalItem = screen.getByRole('menuitem', { name: m.workspace_new_terminal() });
		expect(items.indexOf(moveItem)).toBeLessThan(items.indexOf(newTerminalItem));
		expect(items.indexOf(closeItem)).toBeLessThan(items.indexOf(newTerminalItem));

		await fireEvent.click(moveItem);
		expect(moveSurface).toHaveBeenCalledWith('singleton:git', 'sidebar');
	});

	it('offers move, pop out, and close for an inactive tab context menu', async () => {
		render(WorkspaceTaskBar, {
			host: 'main',
			hostState: {
				order: ['singleton:chat', 'singleton:git', 'file:one'],
				activeId: 'singleton:git',
				mru: ['singleton:git', 'singleton:chat'],
			},
			labelFor: (surfaceId: string) =>
				surfaceId === 'singleton:chat' ? 'Chat' : surfaceId === 'singleton:git' ? 'Git' : 'one.ts',
			onSelect: vi.fn(),
		});

		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'one.ts' }));
		await waitFor(() =>
			expect(screen.getByRole('menuitem', { name: m.workspace_move_to_sidebar() })).toBeTruthy(),
		);
		expect(screen.getByRole('menuitem', { name: m.workspace_pop_out() })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: m.workspace_close_tab() })).toBeTruthy();

		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_move_to_sidebar() }));
		expect(moveSurface).toHaveBeenCalledWith('file:one', 'sidebar');
	});

	it('shows File Sessions only when Files is the active tab', async () => {
		const { rerender } = render(WorkspaceTaskBar, {
			host: 'sidebar',
			hostState: {
				order: ['singleton:files', 'singleton:git'],
				activeId: 'singleton:files',
				mru: ['singleton:files', 'singleton:git'],
			},
			labelFor: (surfaceId: string) => (surfaceId === 'singleton:files' ? 'Files' : 'Git'),
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		const fileSessionsItem = screen.getByRole('menuitem', {
			name: m.file_session_file_sessions(),
		});
		await fireEvent.click(fileSessionsItem);
		expect(showOpenFiles).toHaveBeenCalledOnce();

		await rerender({
			host: 'sidebar',
			hostState: {
				order: ['singleton:files', 'singleton:git'],
				activeId: 'singleton:git',
				mru: ['singleton:git', 'singleton:files'],
			},
			labelFor: (surfaceId: string) => (surfaceId === 'singleton:files' ? 'Files' : 'Git'),
			onSelect: vi.fn(),
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		expect(screen.queryByRole('menuitem', { name: m.file_session_file_sessions() })).toBeNull();
	});
});
