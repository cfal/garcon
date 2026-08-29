<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuLabel,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import {
		getGhCapability,
		getNotifications,
		getTerminalRegistry,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import {
		PORTABLE_SINGLETON_KINDS,
		singletonSurfaceId,
		terminalSurfaceId,
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
	}: {
		windowId: WorkspaceWindowId;
		tabs: WorkspaceWindowTabState;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const terminals = getTerminalRegistry();
	const ghCapability = getGhCapability();
	const notifications = getNotifications();
	let creatingTerminal = $state(false);
	const terminalLimitReached = $derived(terminals.orderedSessions.length >= TERMINAL_SESSION_LIMIT);
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

	function notifyFailure(error: unknown): void {
		notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
	}

	function openSingleton(kind: PortableSingletonKind): void {
		void workspace.openSingletonAsTab(kind, windowId).catch(notifyFailure);
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
		aria-label={m.workspace_add_to_window()}
		title={m.workspace_add_to_window()}
		data-workspace-window-add-trigger={windowId}
	>
		<Plus class="h-3.5 w-3.5" />
	</DropdownMenuTrigger>
	<DropdownMenuContent align="end" class="w-64" data-workspace-window-add-menu={windowId}>
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
					onSelect={() => void workspace.openTerminalSession(session.metadata.terminalId, windowId)}
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
	</DropdownMenuContent>
</DropdownMenu>
