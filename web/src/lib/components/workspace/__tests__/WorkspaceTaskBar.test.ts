import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceTaskBar from '../WorkspaceTaskBar.svelte';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '../../shared/__tests__/resize-observer-harness.js';
import type { DesktopLayoutNode, PaneId } from '$lib/workspace/surface-types.js';
import * as m from '$lib/paraglide/messages.js';

const {
	surfaces,
	desktopRoot,
	moveTabToPane,
	splitTabToEdge,
	popOutFile,
	closeSurface,
	showOpenFiles,
	createTerminal,
	openTerminalSession,
	openSingletonAsTab,
	toggleFullscreen,
	fullscreen,
	terminalRegistry,
} = vi.hoisted(() => {
	const pane = (id: string, tabs: string[]): DesktopLayoutNode => ({
		type: 'pane',
		id: id as PaneId,
		tabs: { order: tabs, activeId: tabs[0] ?? null, mru: [...tabs] },
	});
	return {
		surfaces: {
			'singleton:chat': { id: 'singleton:chat', type: 'singleton', kind: 'chat' },
			'singleton:git': { id: 'singleton:git', type: 'singleton', kind: 'git' },
			'singleton:files': { id: 'singleton:files', type: 'singleton', kind: 'files' },
			'file:one': { id: 'file:one', type: 'file', fileSessionId: 'one' },
		} as Record<string, { id: string; type: string; kind?: string; fileSessionId?: string }>,
		desktopRoot: {
			current: {
				type: 'split',
				id: 'split-1',
				direction: 'horizontal',
				ratio: 0.5,
				children: [
					pane('pane-main', ['singleton:chat', 'singleton:git', 'file:one']),
					pane('pane-2', ['singleton:files']),
				],
			} as DesktopLayoutNode,
		},
		moveTabToPane: vi.fn(async () => undefined),
		splitTabToEdge: vi.fn(async () => undefined),
		popOutFile: vi.fn(async () => true),
		closeSurface: vi.fn(async () => true),
		showOpenFiles: vi.fn(),
		createTerminal: vi.fn(async () => 'terminal-created'),
		openTerminalSession: vi.fn(async () => undefined),
		openSingletonAsTab: vi.fn(async () => undefined),
		toggleFullscreen: vi.fn(async () => undefined),
		fullscreen: { paneId: null as PaneId | null },
		terminalRegistry: {
			orderedSessions: [] as Array<{
				metadata: { terminalId: string; displaySequence: number };
			}>,
			listStatus: 'ready',
		},
	};
});

vi.mock('$lib/context', () => ({
	getWorkspaceCoordinator: () => ({
		layout: {
			surface: (surfaceId: string) => surfaces[surfaceId] ?? null,
			get snapshot() {
				return { fullscreenPaneId: fullscreen.paneId, desktopRoot: desktopRoot.current };
			},
		},
		moveTabToPane,
		splitTabToEdge,
		popOutFile,
		closeSurface,
		isSurfaceCloseBlocked: () => false,
		openSingletonAsTab,
		createTerminal,
		openTerminalSession,
		toggleFullscreen,
		canSplitPane: true,
	}),
	getTerminalRegistry: () => terminalRegistry,
	getGhCapability: () => ({ hasChecked: true, available: true }),
	getNotifications: () => ({ error: vi.fn() }),
	getFileSessions: () => ({ showOpenFiles }),
	getOptionalTransientLayers: () => null,
}));

const PANE_MAIN = 'pane-main' as PaneId;
const PANE_TWO = 'pane-2' as PaneId;

function paneTabs(order: string[], activeId = order[0] ?? null) {
	return { order, activeId, mru: [...order] };
}

describe('WorkspaceTaskBar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		terminalRegistry.orderedSessions = [];
		terminalRegistry.listStatus = 'ready';
		fullscreen.paneId = null;
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

	it('puts active-tab operations at the top of the pane menu', async () => {
		render(WorkspaceTaskBar, {
			paneId: PANE_MAIN,
			tabs: paneTabs(['singleton:chat', 'singleton:git', 'file:one'], 'singleton:git'),
			singlePane: false,
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

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		const items = screen.getAllByRole('menuitem');
		const moveItem = screen.getByRole('menuitem', {
			name: m.workspace_move_to_pane({ pane: 'Files' }),
		});
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
		expect(moveTabToPane).toHaveBeenCalledWith('singleton:git', PANE_TWO);
	});

	it('offers edge splits for a tab in a multi-tab pane', async () => {
		render(WorkspaceTaskBar, {
			paneId: PANE_MAIN,
			tabs: paneTabs(['singleton:chat', 'singleton:git'], 'singleton:git'),
			singlePane: false,
			labelFor: (surfaceId: string) => (surfaceId === 'singleton:chat' ? 'Chat' : 'Git'),
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		const splitRight = screen.getByRole('menuitem', { name: m.workspace_split_tab_right() });
		expect(screen.getByRole('menuitem', { name: m.workspace_split_tab_down() })).toBeTruthy();

		await fireEvent.click(splitRight);
		expect(splitTabToEdge).toHaveBeenCalledWith('singleton:git', PANE_MAIN, 'right');
	});

	it('creates a terminal as a tab in its pane', async () => {
		render(WorkspaceTaskBar, {
			paneId: PANE_TWO,
			tabs: paneTabs(['singleton:files']),
			singlePane: false,
			labelFor: () => 'Files',
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_new_terminal() }));

		await waitFor(() =>
			expect(createTerminal).toHaveBeenCalledWith(PANE_TWO, `workspace-taskbar:${PANE_TWO}`),
		);
	});

	it('places standalone Git view commands directly after New Terminal in the pane menu', async () => {
		terminalRegistry.orderedSessions = [{ metadata: { terminalId: 'one', displaySequence: 1 } }];
		render(WorkspaceTaskBar, {
			paneId: PANE_MAIN,
			tabs: paneTabs(['singleton:chat']),
			singlePane: true,
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
		expect(openSingletonAsTab).toHaveBeenCalledWith('git-history', PANE_MAIN);
	});

	it('opens an existing singleton as a tab through the pane menu', async () => {
		render(WorkspaceTaskBar, {
			paneId: PANE_TWO,
			tabs: paneTabs(['singleton:files']),
			singlePane: false,
			labelFor: () => 'Files',
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		await fireEvent.click(
			screen.getByRole('menuitem', {
				name: m.workspace_open_surface({ surface: m.workspace_surface_git_workbench() }),
			}),
		);

		expect(openSingletonAsTab).toHaveBeenCalledWith('git', PANE_TWO);
	});

	it('moves an existing standalone Git view into the pane', async () => {
		surfaces['singleton:git-history'] = {
			id: 'singleton:git-history',
			type: 'singleton',
			kind: 'git-history',
		};
		render(WorkspaceTaskBar, {
			paneId: PANE_TWO,
			tabs: paneTabs(['singleton:files']),
			singlePane: false,
			labelFor: () => 'Files',
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_open_git_history() }));

		expect(openSingletonAsTab).toHaveBeenCalledWith('git-history', PANE_TWO);
	});

	it('offers one canonical fullscreen command per pane', async () => {
		render(WorkspaceTaskBar, {
			paneId: PANE_TWO,
			tabs: paneTabs(['singleton:files']),
			singlePane: false,
			labelFor: () => 'Files',
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		const item = screen.getByRole('menuitem', { name: m.workspace_fullscreen() });
		expect(screen.getAllByRole('menuitem', { name: m.workspace_fullscreen() })).toHaveLength(1);
		expect(
			item.closest('[data-workspace-taskbar-menu]')?.getAttribute('data-workspace-taskbar-menu'),
		).toBe(PANE_TWO);

		await fireEvent.click(item);
		expect(toggleFullscreen).toHaveBeenCalledWith(PANE_TWO);
	});

	it('labels only the fullscreen pane as Exit fullscreen', async () => {
		fullscreen.paneId = PANE_TWO;
		render(WorkspaceTaskBar, {
			paneId: PANE_TWO,
			tabs: paneTabs(['singleton:files']),
			singlePane: false,
			labelFor: () => 'Files',
			onSelect: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		expect(screen.getAllByRole('menuitem', { name: m.workspace_exit_fullscreen() })).toHaveLength(
			1,
		);
	});

	it('omits an open Git view command and labels standalone tabs without a Git prefix', async () => {
		surfaces['singleton:git-history'] = {
			id: 'singleton:git-history',
			type: 'singleton',
			kind: 'git-history',
		};
		render(WorkspaceTaskBar, {
			paneId: PANE_MAIN,
			tabs: paneTabs(['singleton:chat', 'singleton:git-history'], 'singleton:git-history'),
			singlePane: false,
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
			paneId: PANE_MAIN,
			tabs: paneTabs(['singleton:chat', 'singleton:git', 'file:one'], 'singleton:git'),
			singlePane: false,
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

		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'one.ts' }));
		await waitFor(() =>
			expect(
				screen.getByRole('menuitem', { name: m.workspace_move_to_pane({ pane: 'Files' }) }),
			).toBeTruthy(),
		);
		expect(screen.getByRole('menuitem', { name: m.workspace_pop_out() })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: m.workspace_close_tab() })).toBeTruthy();

		await fireEvent.click(
			screen.getByRole('menuitem', { name: m.workspace_move_to_pane({ pane: 'Files' }) }),
		);
		expect(moveTabToPane).toHaveBeenCalledWith('file:one', PANE_TWO);
	});

	it('shows File Sessions only when Files is the active tab', async () => {
		const { rerender } = render(WorkspaceTaskBar, {
			paneId: PANE_TWO,
			tabs: paneTabs(['singleton:files', 'singleton:git'], 'singleton:files'),
			singlePane: false,
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
			paneId: PANE_TWO,
			tabs: paneTabs(['singleton:files', 'singleton:git'], 'singleton:git'),
			singlePane: false,
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
			paneId: PANE_MAIN,
			tabs: paneTabs(['singleton:chat']),
			singlePane: true,
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
		expect(openTerminalSession).toHaveBeenCalledWith('terminal-8', PANE_MAIN);
	});

	it('hides a lone tab rail in a single-pane layout but shows it with multiple panes', async () => {
		const { rerender } = render(WorkspaceTaskBar, {
			paneId: PANE_MAIN,
			tabs: paneTabs(['singleton:chat']),
			singlePane: true,
			labelFor: () => 'Chat',
			onSelect: vi.fn(),
		});

		expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Workspace actions' })).toBeTruthy();

		await rerender({
			paneId: PANE_TWO,
			tabs: paneTabs(['singleton:files']),
			singlePane: false,
			labelFor: () => 'Files',
			onSelect: vi.fn(),
		});

		expect(screen.getByRole('tab', { name: 'Files' })).toBeTruthy();
	});

	it('keeps tab and menu controls in independent toolbar regions', () => {
		const { container } = render(WorkspaceTaskBar, {
			paneId: PANE_MAIN,
			tabs: paneTabs(['singleton:chat', 'singleton:git'], 'singleton:git'),
			singlePane: false,
			labelFor: (surfaceId: string) => (surfaceId === 'singleton:chat' ? 'Chat' : 'Git'),
			onSelect: vi.fn(),
		});

		const start = container.querySelector('[data-workspace-taskbar-start]');
		const center = container.querySelector('[data-workspace-taskbar-center]');
		const end = container.querySelector('[data-workspace-taskbar-end]');
		const tablist = screen.getByRole('tablist', { name: m.workspace_pane_views() });
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
				paneId: PANE_MAIN,
				tabs: paneTabs(
					['singleton:chat', 'singleton:git', 'singleton:files', 'file:one'],
					'file:one',
				),
				singlePane: false,
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
