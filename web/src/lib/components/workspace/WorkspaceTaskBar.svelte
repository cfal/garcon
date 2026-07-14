<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import FileCode from '@lucide/svelte/icons/file-code';
	import Files from '@lucide/svelte/icons/files';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuLabel,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import {
		getGhCapability,
		getNotifications,
		getTerminalRegistry,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import type { HostId, HostState, PortableSingletonKind } from '$lib/workspace/surface-types.js';
	import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
	import { selectVisibleTaskbarSurfaceIds } from './workspace-taskbar-layout';
	import * as m from '$lib/paraglide/messages.js';

	let {
		host,
		hostState,
		labelFor,
		onSelect,
		onFocus,
		menuItems,
		endActions,
	}: {
		host: HostId;
		hostState: HostState;
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		onFocus?: (surfaceId: string) => void;
		menuItems?: Snippet;
		endActions?: Snippet;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const terminals = getTerminalRegistry();
	const ghCapability = getGhCapability();
	const notifications = getNotifications();
	const singletonKinds: readonly PortableSingletonKind[] = [
		'git',
		'pull-requests',
		'files',
		'quick-git',
	];
	const singletonLabels: Record<PortableSingletonKind, () => string> = {
		git: m.workspace_surface_git_workbench,
		'pull-requests': m.workspace_surface_pull_requests,
		files: m.workspace_surface_files,
		'quick-git': m.workspace_surface_quick_git,
	};

	let tabViewport: HTMLDivElement | null = $state(null);
	let measurementRail: HTMLDivElement | null = $state(null);
	let taskbarRoot: HTMLDivElement | null = $state(null);
	let menuControl: HTMLDivElement | null = $state(null);
	let endControl: HTMLDivElement | null = $state(null);
	let visibleSurfaceIds = $state.raw<readonly string[] | null>(null);
	let creatingTerminal = $state(false);
	const displayedSurfaceIds = $derived(visibleSurfaceIds ?? hostState.order);
	const hiddenSurfaceIds = $derived(
		hostState.order.filter((surfaceId) => !displayedSurfaceIds.includes(surfaceId)),
	);
	const closedSingletonKinds = $derived(
		singletonKinds.filter(
			(kind) => canOffer(kind) && !workspace.layout.surface(`singleton:${kind}`),
		),
	);

	$effect(() => {
		const root = taskbarRoot;
		const rail = measurementRail;
		const menu = menuControl;
		if (!root || !rail || !menu || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => recomputeVisibleTabs());
		observer.observe(root.parentElement ?? root);
		observer.observe(menu);
		if (endControl) observer.observe(endControl);
		observer.observe(rail);
		for (const item of rail.querySelectorAll<HTMLElement>('[data-taskbar-measure-id]')) {
			observer.observe(item);
		}
		queueMicrotask(recomputeVisibleTabs);
		return () => observer.disconnect();
	});

	$effect(() => {
		hostState.order.map((surfaceId) => `${surfaceId}:${labelFor(surfaceId)}`).join('|');
		hostState.activeId;
		untrack(() => queueMicrotask(recomputeVisibleTabs));
	});

	function canOffer(kind: PortableSingletonKind): boolean {
		return (
			kind !== 'pull-requests' ||
			!ghCapability.hasChecked ||
			ghCapability.available ||
			Boolean(workspace.layout.surface('singleton:pull-requests'))
		);
	}

	function iconKind(surfaceId: string): string {
		if (surfaceId === 'singleton:chat') return 'chat';
		if (surfaceId === 'singleton:git') return 'git';
		if (surfaceId === 'singleton:pull-requests') return 'pull-requests';
		if (surfaceId === 'singleton:files') return 'files';
		if (surfaceId === 'singleton:quick-git') return 'quick-git';
		if (surfaceId === 'terminal-launcher' || surfaceId.startsWith('terminal:')) return 'terminal';
		return 'file';
	}

	function recomputeVisibleTabs(): void {
		if (!taskbarRoot || !tabViewport || !measurementRail || !menuControl) return;
		const widths = new Map<string, number>();
		for (const item of measurementRail.querySelectorAll<HTMLElement>('[data-taskbar-measure-id]')) {
			const surfaceId = item.dataset.taskbarMeasureId;
			if (surfaceId) widths.set(surfaceId, item.getBoundingClientRect().width);
		}
		const fixedWidth = menuControl.offsetWidth + (endControl?.offsetWidth ?? 0);
		const controlCount = 1 + ((endControl?.offsetWidth ?? 0) > 0 ? 1 : 0);
		const clusterGaps = controlCount * 6;
		const railChrome = 6;
		const availableWidth = Math.max(
			0,
			(taskbarRoot.parentElement?.clientWidth ?? taskbarRoot.clientWidth) -
				fixedWidth -
				clusterGaps -
				railChrome,
		);
		visibleSurfaceIds = selectVisibleTaskbarSurfaceIds({
			order: hostState.order,
			activeId: hostState.activeId,
			pinnedIds: host === 'main' ? ['singleton:chat'] : [],
			availableWidth,
			widths,
			gap: 2,
		});
	}

	async function createTerminal(): Promise<void> {
		if (creatingTerminal) return;
		creatingTerminal = true;
		try {
			await workspace.createTerminal(host, `workspace-taskbar:${host}`);
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : m.terminal_create_failed());
		} finally {
			creatingTerminal = false;
		}
	}

	function handleKeydown(event: KeyboardEvent, surfaceId: string): void {
		const tabs = Array.from(tabViewport?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
		const index = tabs.indexOf(event.currentTarget as HTMLButtonElement);
		if (index < 0 || tabs.length === 0) return;
		let nextIndex: number;
		if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
		else if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
		else if (event.key === 'Home') nextIndex = 0;
		else if (event.key === 'End') nextIndex = tabs.length - 1;
		else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onSelect(surfaceId);
			return;
		} else return;
		event.preventDefault();
		tabs[nextIndex]?.focus();
	}
</script>

{#snippet icon(surfaceId: string)}
	{@const kind = iconKind(surfaceId)}
	{#if kind === 'chat'}<MessageSquare class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'git'}<GitBranch class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'pull-requests'}<GitPullRequest class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'files'}<Files class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'quick-git'}<GitCommitHorizontal class="h-3.5 w-3.5 shrink-0" />
	{:else if kind === 'terminal'}<SquareTerminal class="h-3.5 w-3.5 shrink-0" />
	{:else}<FileCode class="h-3.5 w-3.5 shrink-0" />{/if}
{/snippet}

{#snippet tab(surfaceId: string, measurement = false)}
	<button
		type="button"
		role={measurement ? undefined : 'tab'}
		id={measurement ? undefined : `${host}-tab-${surfaceId}`}
		aria-controls={measurement ? undefined : `${host}-panel-${surfaceId}`}
		aria-selected={measurement ? undefined : hostState.activeId === surfaceId}
		tabindex={measurement ? -1 : hostState.activeId === surfaceId ? 0 : -1}
		data-taskbar-measure-id={measurement ? surfaceId : undefined}
		class={`relative inline-flex h-8 max-w-40 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium transition-colors duration-150 sm:gap-1.5 sm:px-3 sm:text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
			!measurement && hostState.activeId === surfaceId
				? 'bg-chat-tabs-active text-chat-tabs-active-foreground shadow-sm border border-chat-tabs-active-border'
				: 'border border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
		}`}
		title={labelFor(surfaceId)}
		onclick={measurement ? undefined : () => onSelect(surfaceId)}
		onfocus={measurement ? undefined : () => onFocus?.(surfaceId)}
		onpointerdown={measurement ? undefined : () => onFocus?.(surfaceId)}
		onkeydown={measurement ? undefined : (event) => handleKeydown(event, surfaceId)}
	>
		{@render icon(surfaceId)}
		<span class="hidden min-w-0 truncate lg:inline">{labelFor(surfaceId)}</span>
	</button>
{/snippet}

<div
	bind:this={taskbarRoot}
	class="pointer-events-auto relative flex w-max min-w-0 max-w-full items-center gap-1.5"
>
	<div
		class="relative flex min-w-0 items-center rounded-lg border border-chat-tabs-rail-border bg-chat-tabs-rail p-0.5 text-foreground shadow-sm"
	>
		<div
			bind:this={tabViewport}
			class="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
			role="tablist"
			aria-label={host === 'main' ? m.workspace_main_views() : m.workspace_sidebar_views()}
		>
			{#each displayedSurfaceIds as surfaceId (surfaceId)}
				{@render tab(surfaceId)}
			{/each}
		</div>
	</div>

	<DropdownMenu>
		<div
			bind:this={menuControl}
			class="relative flex shrink-0 rounded-lg border border-chat-tabs-rail-border bg-chat-tabs-rail p-0.5 text-foreground shadow-sm"
		>
			<DropdownMenuTrigger
				class="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label={m.workspace_taskbar_actions()}
				title={m.workspace_taskbar_actions()}
			>
				<EllipsisVertical class="h-3.5 w-3.5" />
			</DropdownMenuTrigger>
		</div>
		<DropdownMenuContent align="end" class="w-64">
			{#if hiddenSurfaceIds.length > 0}
				<DropdownMenuLabel
					>{host === 'main'
						? m.workspace_main_views()
						: m.workspace_sidebar_views()}</DropdownMenuLabel
				>
				{#each hiddenSurfaceIds as surfaceId (surfaceId)}
					<DropdownMenuItem onclick={() => onSelect(surfaceId)}>
						{@render icon(surfaceId)}
						<span class="min-w-0 truncate">{labelFor(surfaceId)}</span>
					</DropdownMenuItem>
				{/each}
				<DropdownMenuSeparator />
			{/if}

			<DropdownMenuItem
				disabled={creatingTerminal ||
					terminals.orderedSessions.length >= TERMINAL_SESSION_LIMIT ||
					terminals.listStatus !== 'ready'}
				onclick={() => void createTerminal()}
			>
				<SquareTerminal />
				{m.workspace_new_terminal()}
			</DropdownMenuItem>
			{#each closedSingletonKinds as kind (kind)}
				<DropdownMenuItem onclick={() => void workspace.openSingleton(kind, host)}>
					{@render icon(`singleton:${kind}`)}
					{m.workspace_open_surface({ surface: singletonLabels[kind]() })}
				</DropdownMenuItem>
			{/each}
			{#if menuItems}
				<DropdownMenuSeparator />
				{@render menuItems()}
			{/if}
		</DropdownMenuContent>
	</DropdownMenu>

	<div bind:this={endControl} class="flex shrink-0 empty:hidden">
		{@render endActions?.()}
	</div>

	<div
		bind:this={measurementRail}
		class="pointer-events-none invisible absolute -left-[10000px] top-0 flex items-center gap-0.5"
		aria-hidden="true"
	>
		{#each hostState.order as surfaceId (surfaceId)}
			{@render tab(surfaceId, true)}
		{/each}
	</div>
</div>
