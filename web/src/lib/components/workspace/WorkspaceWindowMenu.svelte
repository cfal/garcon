<script lang="ts">
	import type { Snippet } from 'svelte';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
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
		getFileSessions,
		getGhCapability,
		getNotifications,
		getTerminalRegistry,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import {
		PORTABLE_SINGLETON_KINDS,
		singletonSurfaceId,
		terminalSurfaceId,
		type ActiveSurfaceKind,
		type PortableSingletonKind,
		type WorkspaceWindowId,
		type WorkspaceWindowTabState,
	} from '$lib/workspace/surface-types.js';
	import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
	import WorkspaceSurfaceIcon from './WorkspaceSurfaceIcon.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		windowId,
		tabs,
		hiddenSurfaceIds,
		labelFor,
		onSelect,
		menuItems,
	}: {
		windowId: WorkspaceWindowId;
		tabs: WorkspaceWindowTabState;
		hiddenSurfaceIds: readonly string[];
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		menuItems?: Snippet<[string]>;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const fileSessions = getFileSessions();
	const terminals = getTerminalRegistry();
	const ghCapability = getGhCapability();
	const notifications = getNotifications();
	let creatingTerminal = $state(false);
	const terminalLimitReached = $derived(terminals.orderedSessions.length >= TERMINAL_SESSION_LIMIT);
	const activeSurface = $derived(workspace.layout.surface(tabs.activeId));
	const canOfferCloseTab = $derived(activeSurface !== null && activeSurface.type !== 'chat');
	const unplacedTerminalSessions = $derived(
		terminals.orderedSessions.filter(
			(session) => !workspace.layout.surface(terminalSurfaceId(session.metadata.terminalId)),
		),
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
	const singletonLabels: Record<PortableSingletonKind, () => string> = {
		git: m.workspace_surface_git_workbench,
		'git-history': m.workspace_surface_git_history,
		'git-compare': m.workspace_surface_git_compare,
		'pull-requests': m.workspace_surface_pull_requests,
		files: m.workspace_surface_files,
		commit: m.workspace_surface_commit,
	};

	function canOffer(kind: PortableSingletonKind): boolean {
		return (
			kind !== 'pull-requests' ||
			!ghCapability.hasChecked ||
			ghCapability.available ||
			Boolean(workspace.layout.surface(singletonSurfaceId('pull-requests')))
		);
	}

	function surfaceKind(surfaceId: string): ActiveSurfaceKind {
		const surface = workspace.layout.surface(surfaceId);
		if (!surface) return 'file';
		return surface.type === 'singleton' ? surface.kind : surface.type;
	}

	function notifyFailure(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
	}

	function openSingleton(kind: PortableSingletonKind): void {
		void workspace.openSingletonAsTab(kind, windowId).catch(notifyFailure);
	}

	function closeActiveTab(): void {
		void workspace.closeSurface(tabs.activeId).catch(notifyFailure);
	}

	async function createTerminal(): Promise<void> {
		if (creatingTerminal) return;
		creatingTerminal = true;
		try {
			await workspace.createTerminal(windowId, `workspace-window:${windowId}`);
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : m.terminal_create_failed());
		} finally {
			creatingTerminal = false;
		}
	}
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		aria-label={m.workspace_window_actions()}
		title={m.workspace_window_actions()}
		data-workspace-window-menu-trigger={windowId}
	>
		<EllipsisVertical class="h-3.5 w-3.5" />
	</DropdownMenuTrigger>
	<DropdownMenuContent align="end" class="w-64" data-workspace-window-menu={windowId}>
		{#if hiddenSurfaceIds.length > 0}
			<DropdownMenuLabel>{m.workspace_open_tabs()}</DropdownMenuLabel>
			{#each hiddenSurfaceIds as surfaceId (surfaceId)}
			<DropdownMenuItem
				data-workspace-hidden-tab-id={surfaceId}
				onSelect={() => onSelect(surfaceId)}
			>
					<WorkspaceSurfaceIcon kind={surfaceKind(surfaceId)} />
					<span class="min-w-0 truncate">{labelFor(surfaceId)}</span>
				</DropdownMenuItem>
			{/each}
			<DropdownMenuSeparator />
		{/if}
		<DropdownMenuItem
			disabled={creatingTerminal || terminalLimitReached}
			title={terminalLimitReached ? m.terminal_limit_reached() : undefined}
			onSelect={() => void createTerminal()}
		>
			<SquareTerminal />
			{terminalLimitReached ? m.terminal_limit_reached() : m.workspace_new_terminal()}
		</DropdownMenuItem>
		{#each availableGitViewKinds as kind (kind)}
			<DropdownMenuItem onSelect={() => openSingleton(kind)}>
				<WorkspaceSurfaceIcon {kind} />
				{kind === 'git-history' ? m.workspace_open_git_history() : m.workspace_open_git_compare()}
			</DropdownMenuItem>
		{/each}
		{#if unplacedTerminalSessions.length > 0}
			<DropdownMenuLabel>{m.workspace_open_terminals()}</DropdownMenuLabel>
			{#each unplacedTerminalSessions as session (session.metadata.terminalId)}
				<DropdownMenuItem
					onSelect={() =>
						void workspace.openTerminalSession(session.metadata.terminalId, windowId)}
				>
					<SquareTerminal />
					{m.workspace_surface_terminal_number({ number: session.metadata.displaySequence })}
				</DropdownMenuItem>
			{/each}
		{/if}
		{#each otherAvailableSingletonKinds as kind (kind)}
			<DropdownMenuItem onSelect={() => openSingleton(kind)}>
				<WorkspaceSurfaceIcon {kind} />
				{m.workspace_open_surface({ surface: singletonLabels[kind]() })}
			</DropdownMenuItem>
		{/each}
		{#if menuItems}
			<DropdownMenuSeparator />
			{@render menuItems(tabs.activeId)}
		{/if}
		{#if tabs.activeId === singletonSurfaceId('files')}
			<DropdownMenuSeparator />
			<DropdownMenuItem onSelect={() => fileSessions.showOpenFiles()}>
				<FolderOpen />
				{m.file_session_file_sessions()}
			</DropdownMenuItem>
		{/if}
		{#if canOfferCloseTab}
			<DropdownMenuSeparator />
			<DropdownMenuItem
				variant="destructive"
				disabled={workspace.isSurfaceCloseBlocked(tabs.activeId)}
				onSelect={closeActiveTab}
			>
				<X />
				{m.workspace_close_tab()}
			</DropdownMenuItem>
		{/if}
	</DropdownMenuContent>
</DropdownMenu>
