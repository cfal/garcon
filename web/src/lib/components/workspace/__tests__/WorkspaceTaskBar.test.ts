import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceTaskBar from '../WorkspaceTaskBar.svelte';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '../../shared/__tests__/resize-observer-harness.js';
import * as m from '$lib/paraglide/messages.js';

const {
	surfaces,
	moveSurface,
	popOutFile,
	closeSurface,
	showOpenFiles,
	createTerminal,
	openTerminalSession,
	openSingleton,
	toggleFullscreen,
	fullscreen,
	terminalRegistry,
} = vi.hoisted(() => ({
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
	createTerminal: vi.fn(async () => 'terminal-created'),
	openTerminalSession: vi.fn(async () => undefined),
	openSingleton: vi.fn(async () => undefined),
	toggleFullscreen: vi.fn(async () => undefined),
	fullscreen: { host: null as 'main' | 'sidebar' | null },
	terminalRegistry: {
		orderedSessions: [] as Array<{
			metadata: { terminalId: string; displaySequence: number };
		}>,
		listStatus: 'ready',
	},
}));

vi.mock('$lib/context', () => ({
	getWorkspaceCoordinator: () => ({
		layout: {
			surface: (surfaceId: string) => surfaces[surfaceId] ?? null,
			get snapshot() {
				return { fullscreenHost: fullscreen.host };
			},
		},
		moveSurface,
		popOutFile,
		closeSurface,
		isSurfaceCloseBlocked: () => false,
		openSingleton,
		createTerminal,
		openTerminalSession,
		toggleFullscreen,
	}),
	getTerminalRegistry: () => terminalRegistry,
	getGhCapability: () => ({ hasChecked: true, available: true }),
	getNotifications: () => ({ error: vi.fn() }),
	getFileSessions: () => ({ showOpenFiles }),
	getOptionalTransientLayers: () => null,
}));

describe('WorkspaceTaskBar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		terminalRegistry.orderedSessions = [];
		terminalRegistry.listStatus = 'ready';
		fullscreen.host = null;
		delete surfaces['singleton:git-history'];
		delete surfaces['singleton:git-compare'];
		vi.stubGlobal('ResizeObserver', undefined);
		vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
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
		expect(
			screen.queryByRole('menuitem', {
				name: m.workspace_open_surface({ surface: m.workspace_surface_git_workbench() }),
			}),
		).toBeNull();
		expect(items.indexOf(moveItem)).toBeLessThan(items.indexOf(newTerminalItem));
		expect(items.indexOf(closeItem)).toBeLessThan(items.indexOf(newTerminalItem));

		await fireEvent.click(moveItem);
		expect(moveSurface).toHaveBeenCalledWith('singleton:git', 'sidebar');
	});

	it.each([
		[false, 'lucide-panel-right'],
		[true, 'lucide-panel-left'],
	] as const)(
		'points main-to-sidebar actions toward the configured sidebar when beforeMain=%s',
		async (workspaceSidebarBeforeMain, iconClass) => {
			render(WorkspaceTaskBar, {
				host: 'main',
				hostState: {
					order: ['singleton:chat', 'singleton:git'],
					activeId: 'singleton:git',
					mru: ['singleton:git', 'singleton:chat'],
				},
				workspaceSidebarBeforeMain,
				labelFor: (surfaceId: string) => (surfaceId === 'singleton:chat' ? 'Chat' : 'Git'),
				onSelect: vi.fn(),
			});

			await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
			const moveItem = screen.getByRole('menuitem', { name: m.workspace_move_to_sidebar() });
			const icon = moveItem.querySelector(`.${iconClass}`);
			expect(icon).toBeTruthy();
			expect(icon?.classList).toContain('rtl:-scale-x-100');
		},
	);

	it('creates a terminal in the taskbar host', async () => {
		render(WorkspaceTaskBar, {
			host: 'sidebar',
			hostState: {
				order: ['singleton:files'],
				activeId: 'singleton:files',
				mru: ['singleton:files'],
			},
			labelFor: () => 'Files',
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_new_terminal() }));

		await waitFor(() =>
			expect(createTerminal).toHaveBeenCalledWith('sidebar', 'workspace-taskbar:sidebar'),
		);
	});

	it.each(['main', 'sidebar'] as const)(
		'places standalone Git view commands directly after New Terminal in the %s menu',
		async (host) => {
			terminalRegistry.orderedSessions = [{ metadata: { terminalId: 'one', displaySequence: 1 } }];
			render(WorkspaceTaskBar, {
				host,
				hostState:
					host === 'main'
						? {
								order: ['singleton:chat'],
								activeId: 'singleton:chat',
								mru: ['singleton:chat'],
							}
						: {
								order: ['singleton:files'],
								activeId: 'singleton:files',
								mru: ['singleton:files'],
							},
				labelFor: (surfaceId: string) => (surfaceId === 'singleton:chat' ? 'Chat' : 'Files'),
				onSelect: vi.fn(),
			});

			await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
			const items = screen.getAllByRole('menuitem');
			const terminal = screen.getByRole('menuitem', { name: m.workspace_new_terminal() });
			const history = screen.getByRole('menuitem', {
				name: m.workspace_open_git_history(),
			});
			const compare = screen.getByRole('menuitem', {
				name: m.workspace_open_git_compare(),
			});
			const fullscreenItem = screen.getByRole('menuitem', {
				name: m.workspace_fullscreen(),
			});
			const openTerminal = screen.getByRole('menuitem', { name: 'Terminal 1' });

			expect(history.querySelector('.lucide-rotate-ccw-clock')).toBeTruthy();
			expect(compare.querySelector('.lucide-git-compare-arrows')).toBeTruthy();
			expect(items.indexOf(terminal)).toBeLessThan(items.indexOf(history));
			expect(items.indexOf(history)).toBeLessThan(items.indexOf(compare));
			expect(items.indexOf(compare)).toBeLessThan(items.indexOf(openTerminal));
			expect(items.indexOf(openTerminal)).toBeLessThan(items.indexOf(fullscreenItem));

			await fireEvent.click(history);
			expect(openSingleton).toHaveBeenCalledWith('git-history', host);
		},
	);

	it('moves an existing generic singleton from the sidebar into the main view', async () => {
		render(WorkspaceTaskBar, {
			host: 'main',
			hostState: {
				order: ['singleton:chat'],
				activeId: 'singleton:chat',
				mru: ['singleton:chat'],
			},
			labelFor: () => 'Chat',
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		await fireEvent.click(
			screen.getByRole('menuitem', {
				name: m.workspace_open_surface({ surface: m.workspace_surface_git_workbench() }),
			}),
		);

		expect(moveSurface).toHaveBeenCalledWith('singleton:git', 'main');
		expect(openSingleton).not.toHaveBeenCalled();
	});

	it('moves an existing standalone Git view from main into the sidebar', async () => {
		surfaces['singleton:git-history'] = {
			id: 'singleton:git-history',
			type: 'singleton',
			kind: 'git-history',
		};
		render(WorkspaceTaskBar, {
			host: 'sidebar',
			hostState: {
				order: ['singleton:files'],
				activeId: 'singleton:files',
				mru: ['singleton:files'],
			},
			labelFor: () => 'Files',
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_open_git_history() }));

		expect(moveSurface).toHaveBeenCalledWith('singleton:git-history', 'sidebar');
		expect(openSingleton).not.toHaveBeenCalled();
	});

	it.each(['main', 'sidebar'] as const)(
		'offers one canonical fullscreen command for the %s host',
		async (host) => {
			render(WorkspaceTaskBar, {
				host,
				hostState:
					host === 'main'
						? {
								order: ['singleton:chat'],
								activeId: 'singleton:chat',
								mru: ['singleton:chat'],
							}
						: {
								order: ['singleton:files'],
								activeId: 'singleton:files',
								mru: ['singleton:files'],
							},
				labelFor: (surfaceId: string) => (surfaceId === 'singleton:chat' ? 'Chat' : 'Files'),
				onSelect: vi.fn(),
			});

			await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
			const item = screen.getByRole('menuitem', { name: m.workspace_fullscreen() });
			expect(screen.getAllByRole('menuitem', { name: m.workspace_fullscreen() })).toHaveLength(1);
			expect(screen.queryByText('Enter workspace fullscreen')).toBeNull();
			expect(
				item.closest('[data-workspace-taskbar-menu]')?.getAttribute('data-workspace-taskbar-menu'),
			).toBe(host);

			await fireEvent.click(item);
			expect(toggleFullscreen).toHaveBeenCalledWith(host);
		},
	);

	it.each(['main', 'sidebar'] as const)(
		'labels only the fullscreen %s host as Exit fullscreen',
		async (host) => {
			fullscreen.host = host;
			render(WorkspaceTaskBar, {
				host,
				hostState:
					host === 'main'
						? {
								order: ['singleton:chat'],
								activeId: 'singleton:chat',
								mru: ['singleton:chat'],
							}
						: {
								order: ['singleton:files'],
								activeId: 'singleton:files',
								mru: ['singleton:files'],
							},
				labelFor: (surfaceId: string) => (surfaceId === 'singleton:chat' ? 'Chat' : 'Files'),
				onSelect: vi.fn(),
			});

			await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
			expect(screen.getAllByRole('menuitem', { name: m.workspace_exit_fullscreen() })).toHaveLength(
				1,
			);
		},
	);

	it('omits an open Git view command and labels standalone tabs without a Git prefix', async () => {
		surfaces['singleton:git-history'] = {
			id: 'singleton:git-history',
			type: 'singleton',
			kind: 'git-history',
		};
		render(WorkspaceTaskBar, {
			host: 'main',
			hostState: {
				order: ['singleton:chat', 'singleton:git-history'],
				activeId: 'singleton:git-history',
				mru: ['singleton:git-history', 'singleton:chat'],
			},
			labelFor: (surfaceId: string) => (surfaceId === 'singleton:chat' ? 'Chat' : 'History'),
			onSelect: vi.fn(),
		});

		expect(screen.getByRole('tab', { name: 'History' })).toBeTruthy();
		expect(screen.queryByRole('tab', { name: 'Git History' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		expect(screen.queryByRole('menuitem', { name: m.workspace_open_git_history() })).toBeNull();
		expect(screen.getByRole('menuitem', { name: m.workspace_open_git_compare() })).toBeTruthy();
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

	it('offers unplaced terminal sessions when the creation limit is reached', async () => {
		terminalRegistry.orderedSessions = Array.from({ length: 8 }, (_, index) => ({
			metadata: { terminalId: `terminal-${index + 1}`, displaySequence: index + 1 },
		}));
		render(WorkspaceTaskBar, {
			host: 'main',
			hostState: {
				order: ['singleton:chat'],
				activeId: 'singleton:chat',
				mru: ['singleton:chat'],
			},
			labelFor: () => 'Chat',
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		expect(
			screen
				.getByRole('menuitem', { name: m.terminal_limit_reached() })
				.getAttribute('data-disabled'),
		).not.toBeNull();
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal 8' }));
		expect(openTerminalSession).toHaveBeenCalledWith('terminal-8', 'main');
	});

	it('hides a lone main tab while keeping a lone sidebar tab visible', async () => {
		const { rerender } = render(WorkspaceTaskBar, {
			host: 'main',
			hostState: {
				order: ['singleton:chat'],
				activeId: 'singleton:chat',
				mru: ['singleton:chat'],
			},
			labelFor: () => 'Chat',
			onSelect: vi.fn(),
		});

		expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Workspace actions' })).toBeTruthy();

		await rerender({
			host: 'sidebar',
			hostState: {
				order: ['singleton:files'],
				activeId: 'singleton:files',
				mru: ['singleton:files'],
			},
			labelFor: () => 'Files',
			onSelect: vi.fn(),
		});

		expect(screen.getByRole('tab', { name: 'Files' })).toBeTruthy();
	});

	it('keeps tab and menu controls in independent toolbar regions', () => {
		const { container } = render(WorkspaceTaskBar, {
			host: 'main',
			hostState: {
				order: ['singleton:chat', 'singleton:git'],
				activeId: 'singleton:git',
				mru: ['singleton:git', 'singleton:chat'],
			},
			labelFor: (surfaceId: string) => (surfaceId === 'singleton:chat' ? 'Chat' : 'Git'),
			onSelect: vi.fn(),
		});

		const start = container.querySelector('[data-workspace-taskbar-start]');
		const center = container.querySelector('[data-workspace-taskbar-center]');
		const end = container.querySelector('[data-workspace-taskbar-end]');
		const tablist = screen.getByRole('tablist', { name: m.workspace_main_views() });
		const menu = screen.getByRole('button', { name: m.workspace_taskbar_actions() });

		expect(start).toBeTruthy();
		expect(center?.contains(tablist)).toBe(true);
		expect(end?.contains(menu)).toBe(true);
		expect(end?.contains(tablist)).toBe(false);
	});

	it('reserves equal side capacity for a geometrically centered tab rail', async () => {
		const restoreResizeObserver = installResizeObserverHarness();
		try {
			const { container } = render(WorkspaceTaskBar, {
				host: 'main',
				hostState: {
					order: ['singleton:chat', 'singleton:git', 'singleton:files', 'file:one'],
					activeId: 'file:one',
					mru: ['file:one', 'singleton:git', 'singleton:chat'],
				},
				labelFor: (surfaceId: string) =>
					surfaceId === 'singleton:chat'
						? 'Chat'
						: surfaceId === 'singleton:git'
							? 'Git'
							: surfaceId === 'singleton:files'
								? 'Files'
								: 'one.ts',
				onSelect: vi.fn(),
			});
			const root = container.querySelector<HTMLElement>('[data-workspace-taskbar]');
			const start = container.querySelector<HTMLElement>('[data-workspace-taskbar-start]');
			const center = container.querySelector<HTMLElement>('[data-workspace-taskbar-center]');
			const end = container.querySelector<HTMLElement>('[data-workspace-taskbar-end]');
			expect(root && start && center && end).toBeTruthy();
			if (!root || !start || !center || !end) return;

			Object.defineProperty(root, 'clientWidth', { configurable: true, value: 500 });
			Object.defineProperty(start, 'offsetWidth', { configurable: true, value: 110 });
			Object.defineProperty(end, 'offsetWidth', { configurable: true, value: 82 });
			for (const item of container.querySelectorAll<HTMLElement>('[data-taskbar-measure-id]')) {
				vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
					width: 80,
				} as DOMRect);
			}

			await waitFor(() =>
				expect(
					ResizeObserverHarness.instances.some((observer) => observer.observed.has(root)),
				).toBe(true),
			);
			ResizeObserverHarness.emit(root, 500);

			await waitFor(() => expect(center.style.maxWidth).toBe('268px'));
			expect(screen.getAllByRole('tab')).toHaveLength(3);
			expect(screen.getByRole('tab', { name: 'one.ts' })).toBeTruthy();
			expect(screen.queryByRole('tab', { name: 'Files' })).toBeNull();
		} finally {
			restoreResizeObserver();
		}
	});
});
