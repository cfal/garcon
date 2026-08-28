<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import FileCode from '@lucide/svelte/icons/file-code';
	import Files from '@lucide/svelte/icons/files';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import GitCompareArrows from '@lucide/svelte/icons/git-compare-arrows';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import History from '@lucide/svelte/icons/history';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import PanelTop from '@lucide/svelte/icons/panel-top';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import X from '@lucide/svelte/icons/x';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuLabel,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import {
		ContextMenu,
		ContextMenuContent,
		ContextMenuItem,
		ContextMenuTrigger,
	} from '$lib/components/ui/context-menu';
	import {
		getGhCapability,
		getFileSessions,
		getNotifications,
		getTerminalRegistry,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import {
		CHAT_SURFACE_ID,
		PORTABLE_SINGLETON_KINDS,
		singletonSurfaceId,
		terminalSurfaceId,
		type PaneId,
		type PaneTabState,
		type PortableSingletonKind,
	} from '$lib/workspace/surface-types.js';
	import { collectPaneNodes } from '$lib/workspace/pane-tree.js';
	import type { WorkspacePaneDndStore } from '$lib/workspace/pane-dnd.svelte.js';
	import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
	import {
		FLOATING_ICON_TRIGGER_CLASS,
		FLOATING_TAB_ACTIVE_CLASS,
		FLOATING_TAB_IDLE_CLASS,
		FLOATING_TAB_TRIGGER_CLASS,
		FLOATING_TOOLBAR_RAIL_CLASS,
	} from '$lib/components/shared/floating-toolbar-styles.js';
	import { cn } from '$lib/utils/cn';
	import {
		resolveCenteredTaskbarCapacity,
		selectVisibleTaskbarSurfaceIds,
	} from './workspace-taskbar-layout';
	import * as m from '$lib/paraglide/messages.js';

	let {
		paneId,
		tabs,
		singlePane,
		labelFor,
		onSelect,
		onFocus,
		dnd,
		startActions,
		layoutMenuItems,
		menuItems,
		endActions,
	}: {
		paneId: PaneId;
		tabs: PaneTabState;
		singlePane: boolean;
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		onFocus?: (surfaceId: string) => void;
		dnd?: WorkspacePaneDndStore;
		startActions?: Snippet;
		layoutMenuItems?: Snippet;
		menuItems?: Snippet;
		endActions?: Snippet;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const fileSessions = getFileSessions();
	const terminals = getTerminalRegistry();
	const ghCapability = getGhCapability();
	const notifications = getNotifications();
	const singletonLabels: Record<PortableSingletonKind, () => string> = {
		git: m.workspace_surface_git_workbench,
		'git-history': m.workspace_surface_git_history,
		'git-compare': m.workspace_surface_git_compare,
		'pull-requests': m.workspace_surface_pull_requests,
		files: m.workspace_surface_files,
		commit: m.workspace_surface_commit,
	};

	let tabViewport: HTMLDivElement | null = $state(null);
	let measurementRail: HTMLDivElement | null = $state(null);
	let taskbarRoot: HTMLDivElement | null = $state(null);
	let startControls: HTMLDivElement | null = $state(null);
	let endControls: HTMLDivElement | null = $state(null);
	let centeredRailMaxWidth: number | null = $state(null);
	let centeredContentWidth: number | null = $state(null);
	let visibleSurfaceIds = $state.raw<readonly string[] | null>(null);
	let creatingTerminal = $state(false);
	const hideSingleTab = $derived(singlePane && tabs.order.length === 1);
	const displayedSurfaceIds = $derived(visibleSurfaceIds ?? tabs.order);
	const hiddenSurfaceIds = $derived(
		tabs.order.filter((surfaceId) => !displayedSurfaceIds.includes(surfaceId)),
	);
	const gitViewKinds = ['git-history', 'git-compare'] as const;
	const availableGitViewKinds = $derived(
		gitViewKinds.filter((kind) => !tabs.order.includes(singletonSurfaceId(kind))),
	);
	const otherAvailableSingletonKinds = $derived(
		PORTABLE_SINGLETON_KINDS.filter(
			(kind) =>
				!gitViewKinds.includes(kind as (typeof gitViewKinds)[number]) &&
				canOffer(kind) &&
				!tabs.order.includes(singletonSurfaceId(kind)),
		),
	);
	const activeSurfaceId = $derived(tabs.activeId);
	const containsChat = $derived(tabs.order.includes(CHAT_SURFACE_ID));
	const fullscreen = $derived(workspace.layout.snapshot.fullscreenPaneId === paneId);
	const terminalLimitReached = $derived(terminals.orderedSessions.length >= TERMINAL_SESSION_LIMIT);
	const unplacedTerminalSessions = $derived(
		terminals.orderedSessions.filter(
			(session) => !workspace.layout.surface(terminalSurfaceId(session.metadata.terminalId)),
		),
	);
	const otherPanes = $derived(
		collectPaneNodes(workspace.layout.snapshot.desktopRoot).filter((pane) => pane.id !== paneId),
	);

	$effect(() => {
		tabs.order.map((surfaceId) => `${surfaceId}:${labelFor(surfaceId)}`).join('|');
		const root = taskbarRoot;
		const rail = measurementRail;
		const start = startControls;
		const end = endControls;
		if (!root || !rail || !start || !end || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => recomputeVisibleTabs());
		observer.observe(root);
		observer.observe(start);
		observer.observe(end);
		observer.observe(rail);
		for (const item of rail.querySelectorAll<HTMLElement>('[data-taskbar-measure-id]')) {
			observer.observe(item);
		}
		queueMicrotask(recomputeVisibleTabs);
		return () => observer.disconnect();
	});

	$effect(() => {
		tabs.activeId;
		untrack(() => queueMicrotask(recomputeVisibleTabs));
	});

	function canOffer(kind: PortableSingletonKind): boolean {
		return (
			kind !== 'pull-requests' ||
			!ghCapability.hasChecked ||
			ghCapability.available ||
			Boolean(workspace.layout.surface(singletonSurfaceId('pull-requests')))
		);
	}

	function iconKind(surfaceId: string): string {
		const surface = workspace.layout.surface(surfaceId);
		if (!surface || surface.type === 'file') return 'file';
		if (surface.type === 'singleton') return surface.kind;
		return 'terminal';
	}

	function canMoveTab(surfaceId: string): boolean {
		const surface = workspace.layout.surface(surfaceId);
		return Boolean(
			surface && surfaceId !== CHAT_SURFACE_ID && surface.type !== 'terminal-launcher',
		);
	}

	function canPopOutTab(surfaceId: string): boolean {
		return workspace.layout.surface(surfaceId)?.type === 'file';
	}

	function canCloseTab(surfaceId: string): boolean {
		return surfaceId !== CHAT_SURFACE_ID && Boolean(workspace.layout.surface(surfaceId));
	}

	function hasTabActions(surfaceId: string | null): surfaceId is string {
		return Boolean(
			surfaceId &&
				(canMoveTab(surfaceId) || canPopOutTab(surfaceId) || canCloseTab(surfaceId)),
		);
	}

	function openSingletonInPane(kind: PortableSingletonKind): void {
		void workspace.openSingletonAsTab(kind, paneId).catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		});
	}

	function moveTab(surfaceId: string, destinationPaneId: PaneId, index?: number): void {
		const moving =
			index === undefined
				? workspace.moveTabToPane(surfaceId, destinationPaneId)
				: workspace.moveTabToPane(surfaceId, destinationPaneId, index);
		void moving.catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		});
	}

	function moveTabLeft(surfaceId: string): void {
		const index = tabs.order.indexOf(surfaceId);
		if (index <= 0) return;
		moveTab(surfaceId, paneId, index - 1);
	}

	function moveTabRight(surfaceId: string): void {
		const index = tabs.order.indexOf(surfaceId);
		if (index < 0 || index >= tabs.order.length - 1) return;
		moveTab(surfaceId, paneId, index + 1);
	}

	function splitTab(surfaceId: string, edge: 'left' | 'right' | 'top' | 'bottom'): void {
		void workspace.splitTabToEdge(surfaceId, paneId, edge).catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		});
	}

	function mergePane(destinationPaneId: PaneId): void {
		void workspace.mergePaneInto(paneId, destinationPaneId).catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		});
	}

	function recomputeVisibleTabs(): void {
		if (!taskbarRoot || !measurementRail || !startControls || !endControls) return;
		const widths = new Map<string, number>();
		for (const item of measurementRail.querySelectorAll<HTMLElement>('[data-taskbar-measure-id]')) {
			const surfaceId = item.dataset.taskbarMeasureId;
			if (surfaceId) widths.set(surfaceId, item.getBoundingClientRect().width);
		}
		const capacity = resolveCenteredTaskbarCapacity({
			containerWidth: taskbarRoot.clientWidth,
			startWidth: startControls.offsetWidth,
			endWidth: endControls.offsetWidth,
			regionGap: 6,
			railChromeWidth: 6,
		});
		centeredRailMaxWidth = capacity.railWidth;
		centeredContentWidth = capacity.contentWidth;
		visibleSurfaceIds = selectVisibleTaskbarSurfaceIds({
			order: tabs.order,
			activeId: tabs.activeId,
			pinnedIds: [],
			availableWidth: capacity.contentWidth,
			widths,
			gap: 2,
		});
	}

	async function createTerminal(): Promise<void> {
		if (creatingTerminal) return;
		creatingTerminal = true;
		try {
			await workspace.createTerminal(paneId, `workspace-taskbar:${paneId}`);
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : m.terminal_create_failed());
		} finally {
			creatingTerminal = false;
		}
	}

	function handleKeydown(event: KeyboardEvent, surfaceId: string): void {
		const tabsList = Array.from(
			tabViewport?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
		);
		const index = tabsList.indexOf(event.currentTarget as HTMLButtonElement);
		if (index < 0 || tabsList.length === 0) return;
		let nextIndex: number;
		if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabsList.length) % tabsList.length;
		else if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabsList.length;
		else if (event.key === 'Home') nextIndex = 0;
		else if (event.key === 'End') nextIndex = tabsList.length - 1;
		else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onSelect(surfaceId);
			return;
		} else return;
		event.preventDefault();
		tabsList[nextIndex]?.focus();
	}

	function handleTabDragStart(event: DragEvent, surfaceId: string): void {
		if (!dnd) return;
		dnd.startTabDrag(surfaceId, paneId, event);
	}

	function handleTabDragOver(event: DragEvent, surfaceId: string): void {
		dnd?.handleTabDragOver(paneId, surfaceId, event);
	}

	function handleTabListDragOver(event: DragEvent): void {
		dnd?.handleTabListDragOver(paneId, event);
	}

	async function commitTabDrop(referenceSurfaceId: string | null, event: DragEvent): Promise<void> {
		const commit = dnd?.handleTabDrop(paneId, referenceSurfaceId, event);
		if (!commit || commit.target.kind !== 'tab') return;
		try {
			await workspace.moveTabToPane(commit.surfaceId, commit.target.paneId, commit.target.index);
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
		}
	}

	function handleTabDragEnd(): void {
		dnd?.endDrag();
	}

	function tabDropPosition(surfaceId: string): 'before' | 'after' | null {
		const target = dnd?.activeTarget;
		if (target?.kind !== 'tab' || target.paneId !== paneId) return null;
		return target.referenceSurfaceId === surfaceId ? target.position : null;
	}
</script>

{#snippet icon(surfaceId: string, singletonKind?: PortableSingletonKind)}
	{@const kind = singletonKind ?? iconKind(surfaceId)}
	{#if kind === 'chat'}<MessageSquare class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'git'}<GitBranch class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'git-history'}<History class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'git-compare'}<GitCompareArrows class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'pull-requests'}<GitPullRequest class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'files'}<Files class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'commit'}<GitCommitHorizontal class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'terminal'}<SquareTerminal class="h-3.5 w-3.5 shrink-0" />
	{:else}<FileCode class="h-3.5 w-3.5 shrink-0" />{/if}
{/snippet}

{#snippet moveTabItems(surfaceId: string, Item: typeof DropdownMenuItem)}
	{#if canMoveTab(surfaceId)}
		{@const tabIndex = tabs.order.indexOf(surfaceId)}
		<Item disabled={tabIndex <= 0} onclick={() => moveTabLeft(surfaceId)}>
			<ArrowLeft />
			{m.workspace_move_tab_left()}
		</Item>
		<Item
			disabled={tabIndex < 0 || tabIndex >= tabs.order.length - 1}
			onclick={() => moveTabRight(surfaceId)}
		>
			<ArrowRight />
			{m.workspace_move_tab_right()}
		</Item>
		{#each otherPanes as pane (pane.id)}
			{@const paneLabel = pane.tabs.activeId ? labelFor(pane.tabs.activeId) : pane.id}
			<Item onclick={() => moveTab(surfaceId, pane.id)}>
				<PanelRight class="rtl:-scale-x-100" />
				{m.workspace_move_to_pane({ pane: paneLabel })}
			</Item>
		{/each}
		{#if workspace.canSplitPane && tabs.order.length > 1}
			<Item onclick={() => splitTab(surfaceId, 'left')}>
				<PanelRight class="rotate-180 rtl:rotate-0" />
				{m.workspace_split_tab_left()}
			</Item>
			<Item onclick={() => splitTab(surfaceId, 'right')}>
				<PanelRight class="rtl:-scale-x-100" />
				{m.workspace_split_tab_right()}
			</Item>
			<Item onclick={() => splitTab(surfaceId, 'top')}>
				<PanelTop />
				{m.workspace_split_tab_up()}
			</Item>
			<Item onclick={() => splitTab(surfaceId, 'bottom')}>
				<PanelTop class="rotate-180" />
				{m.workspace_split_tab_down()}
			</Item>
		{/if}
	{/if}
{/snippet}

{#snippet tabActions(surfaceId: string, Item: typeof DropdownMenuItem)}
	{@render moveTabItems(surfaceId, Item)}
	{#if canPopOutTab(surfaceId)}
		<Item onclick={() => void workspace.popOutFile(surfaceId)}>
			<Maximize2 />
			{m.workspace_pop_out()}
		</Item>
	{/if}
	{#if canCloseTab(surfaceId)}
		<Item
			variant="destructive"
			disabled={workspace.isSurfaceCloseBlocked(surfaceId)}
			onclick={() => void workspace.closeSurface(surfaceId)}
		>
			<X />
			{m.workspace_close_tab()}
		</Item>
	{/if}
{/snippet}

{#snippet tabButton(surfaceId: string, measurement: boolean, triggerProps: Record<string, unknown>)}
	{@const dropPosition = measurement ? null : tabDropPosition(surfaceId)}
	<button
		{...triggerProps}
		type="button"
		role={measurement ? undefined : 'tab'}
		id={measurement ? undefined : `${paneId}-tab-${surfaceId}`}
		aria-controls={measurement ? undefined : `${paneId}-panel-${surfaceId}`}
		aria-selected={measurement ? undefined : tabs.activeId === surfaceId}
		tabindex={measurement ? -1 : tabs.activeId === surfaceId ? 0 : -1}
		data-taskbar-measure-id={measurement ? surfaceId : undefined}
		class={cn(
			FLOATING_TAB_TRIGGER_CLASS,
			!measurement && tabs.activeId === surfaceId
				? FLOATING_TAB_ACTIVE_CLASS
				: FLOATING_TAB_IDLE_CLASS,
		)}
		style:max-width={measurement || centeredContentWidth == null
			? undefined
			: `${Math.min(160, centeredContentWidth)}px`}
		title={labelFor(surfaceId)}
		draggable={!measurement && dnd && canMoveTab(surfaceId) ? true : undefined}
		ondragstart={!measurement && dnd ? (event) => handleTabDragStart(event, surfaceId) : undefined}
		ondragover={!measurement && dnd ? (event) => handleTabDragOver(event, surfaceId) : undefined}
		ondrop={!measurement && dnd
			? (event) => void commitTabDrop(surfaceId, event)
			: undefined}
		ondragend={!measurement && dnd ? handleTabDragEnd : undefined}
		onclick={measurement ? undefined : () => onSelect(surfaceId)}
		onfocus={measurement ? undefined : () => onFocus?.(surfaceId)}
		onpointerdown={measurement ? undefined : () => onFocus?.(surfaceId)}
		onkeydown={measurement ? undefined : (event) => handleKeydown(event, surfaceId)}
	>
		{#if dropPosition}
			<span
				data-workspace-tab-drop-position={dropPosition}
				class="pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary"
				class:left-0={dropPosition === 'before'}
				class:right-0={dropPosition === 'after'}
			></span>
		{/if}
		{@render icon(surfaceId)}
		<span class="hidden min-w-0 truncate lg:inline">{labelFor(surfaceId)}</span>
	</button>
{/snippet}

{#snippet tab(surfaceId: string, measurement = false)}
	{#if measurement || !hasTabActions(surfaceId)}
		{@render tabButton(surfaceId, measurement, {})}
	{:else}
		<ContextMenu>
			<ContextMenuTrigger>
				{#snippet child({ props })}
					{@render tabButton(surfaceId, false, props)}
				{/snippet}
			</ContextMenuTrigger>
			<ContextMenuContent class="w-56">
				{@render tabActions(surfaceId, ContextMenuItem)}
			</ContextMenuContent>
		</ContextMenu>
	{/if}
{/snippet}

<div
	bind:this={taskbarRoot}
	data-workspace-taskbar
	data-workspace-taskbar-pane={paneId}
	class="pointer-events-none relative grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-x-1.5"
>
	<div
		bind:this={startControls}
		data-workspace-taskbar-start
		class="pointer-events-auto min-w-0 justify-self-start"
	>
		{@render startActions?.()}
	</div>

	<div
		data-workspace-taskbar-center
		class="pointer-events-auto min-w-0 max-w-full justify-self-center overflow-hidden"
		style:max-width={centeredRailMaxWidth == null ? undefined : `${centeredRailMaxWidth}px`}
	>
		{#if !hideSingleTab && displayedSurfaceIds.length > 0}
			<div class={FLOATING_TOOLBAR_RAIL_CLASS}>
				<div
					bind:this={tabViewport}
					class="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
					role="tablist"
					tabindex="-1"
					aria-label={m.workspace_pane_views()}
					ondragover={dnd ? handleTabListDragOver : undefined}
					ondrop={dnd ? (event) => void commitTabDrop(null, event) : undefined}
				>
					{#each displayedSurfaceIds as surfaceId (surfaceId)}
						{@render tab(surfaceId)}
					{/each}
				</div>
			</div>
		{/if}
	</div>

	<div
		bind:this={endControls}
		data-workspace-taskbar-end
		class="pointer-events-auto flex min-w-0 shrink-0 justify-self-end gap-1.5"
	>
		<DropdownMenu>
			<div class={FLOATING_TOOLBAR_RAIL_CLASS}>
				<DropdownMenuTrigger
					class={FLOATING_ICON_TRIGGER_CLASS}
					aria-label={m.workspace_taskbar_actions()}
					title={m.workspace_taskbar_actions()}
				>
					<EllipsisVertical class="h-3.5 w-3.5" />
				</DropdownMenuTrigger>
			</div>
			<DropdownMenuContent align="end" class="w-64" data-workspace-taskbar-menu={paneId}>
				{#if hasTabActions(activeSurfaceId)}
					{@render tabActions(activeSurfaceId, DropdownMenuItem)}
					<DropdownMenuSeparator />
				{/if}
				{#if hiddenSurfaceIds.length > 0}
					<DropdownMenuLabel>{m.workspace_open_tabs()}</DropdownMenuLabel>
					{#each hiddenSurfaceIds as surfaceId (surfaceId)}
						<DropdownMenuItem onclick={() => onSelect(surfaceId)}>
							{@render icon(surfaceId)}
							<span class="min-w-0 truncate">{labelFor(surfaceId)}</span>
						</DropdownMenuItem>
					{/each}
					<DropdownMenuSeparator />
				{/if}

				<DropdownMenuItem
					disabled={creatingTerminal || terminalLimitReached}
					title={terminalLimitReached ? m.terminal_limit_reached() : undefined}
					onclick={() => void createTerminal()}
				>
					<SquareTerminal />
					{terminalLimitReached ? m.terminal_limit_reached() : m.workspace_new_terminal()}
				</DropdownMenuItem>
				{#each availableGitViewKinds as kind (kind)}
					<DropdownMenuItem onclick={() => openSingletonInPane(kind)}>
						{@render icon(singletonSurfaceId(kind), kind)}
						{kind === 'git-history'
							? m.workspace_open_git_history()
							: m.workspace_open_git_compare()}
					</DropdownMenuItem>
				{/each}
				{#if unplacedTerminalSessions.length > 0}
					<DropdownMenuLabel>{m.workspace_open_terminals()}</DropdownMenuLabel>
					{#each unplacedTerminalSessions as session (session.metadata.terminalId)}
						<DropdownMenuItem
							onclick={() => void workspace.openTerminalSession(session.metadata.terminalId, paneId)}
						>
							<SquareTerminal />
							{m.workspace_surface_terminal_number({
								number: session.metadata.displaySequence,
							})}
						</DropdownMenuItem>
					{/each}
				{/if}
				{#each otherAvailableSingletonKinds as kind (kind)}
					<DropdownMenuItem onclick={() => openSingletonInPane(kind)}>
						{@render icon(singletonSurfaceId(kind), kind)}
						{m.workspace_open_surface({ surface: singletonLabels[kind]() })}
					</DropdownMenuItem>
				{/each}
				<DropdownMenuSeparator />
				{@render layoutMenuItems?.()}
				{#if !containsChat && otherPanes.length > 0}
					<DropdownMenuLabel>{m.workspace_pane_layout()}</DropdownMenuLabel>
					{#each otherPanes as pane (pane.id)}
						{@const paneLabel = pane.tabs.activeId ? labelFor(pane.tabs.activeId) : pane.id}
						<DropdownMenuItem onclick={() => mergePane(pane.id)}>
							<PanelRight class="rtl:-scale-x-100" />
							{m.workspace_merge_pane_into({ pane: paneLabel })}
						</DropdownMenuItem>
					{/each}
				{/if}
				<DropdownMenuItem
					data-workspace-fullscreen-menu-item={paneId}
					onclick={() => void workspace.toggleFullscreen(paneId)}
				>
					{#if fullscreen}<Minimize2 />{:else}<Maximize2 />{/if}
					{fullscreen ? m.workspace_exit_fullscreen() : m.workspace_fullscreen()}
				</DropdownMenuItem>
				{#if menuItems}
					<DropdownMenuSeparator />
					{@render menuItems()}
				{/if}
				{#if activeSurfaceId === singletonSurfaceId('files')}
					<DropdownMenuSeparator />
					<DropdownMenuItem onclick={() => fileSessions.showOpenFiles()}>
						<FolderOpen />
						{m.file_session_file_sessions()}
					</DropdownMenuItem>
				{/if}
			</DropdownMenuContent>
		</DropdownMenu>

		<div class="flex shrink-0 empty:hidden">
			{@render endActions?.()}
		</div>
	</div>

	<div
		bind:this={measurementRail}
		class="pointer-events-none invisible absolute -left-[10000px] top-0 flex items-center gap-0.5"
		aria-hidden="true"
	>
		{#each tabs.order as surfaceId (surfaceId)}
			{@render tab(surfaceId, true)}
		{/each}
	</div>
</div>
