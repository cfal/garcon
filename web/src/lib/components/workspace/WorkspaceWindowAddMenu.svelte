<script lang="ts">
	import { untrack } from 'svelte';
	import Plus from '@lucide/svelte/icons/plus';
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
	import {
		PORTABLE_SINGLETON_KINDS,
		singletonSurfaceId,
		terminalSurfaceId,
		type PortableSingletonKind,
		type WorkspaceWindowId,
		type WorkspaceWindowTabState,
	} from '$lib/workspace/surface-types.js';
	import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
	import { terminalDisplayName } from '$lib/terminal/sessions/terminal-display-name.js';
	import WorkspaceSurfaceIcon from './WorkspaceSurfaceIcon.svelte';
	import {
		resolveWorkspaceWindowInlineAddActionCount,
		type WorkspaceWindowTabMeasure,
	} from './workspace-window-add-layout.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		windowId,
		tabs,
		measure,
	}: {
		windowId: WorkspaceWindowId;
		tabs: WorkspaceWindowTabState;
		measure: WorkspaceWindowTabMeasure | null;
	} = $props();

	interface WorkspaceWindowAddAction {
		readonly id: string;
		readonly kind: PortableSingletonKind | 'terminal';
		readonly label: string;
		readonly onclick: () => void;
		readonly disabled?: boolean;
		readonly busy?: boolean;
	}

	const workspace = getWorkspaceCoordinator();
	const terminals = getTerminalRegistry();
	const ghCapability = getGhCapability();
	const notifications = getNotifications();
	let creatingTerminal = $state(false);
	let inlineActionCount = $state(0);
	const terminalLimitReached = $derived(terminals.orderedSessions.length >= TERMINAL_SESSION_LIMIT);
	const unplacedTerminalSessions = $derived(
		terminals.orderedSessions.filter(
			(session) => !workspace.layout.surface(terminalSurfaceId(session.metadata.terminalId)),
		),
	);
	const availableSingletonKinds = $derived(
		PORTABLE_SINGLETON_KINDS.filter(
			(kind) => canOffer(kind) && !tabs.order.includes(singletonSurfaceId(kind)),
		),
	);
	const singletonLabels: Record<PortableSingletonKind, () => string> = {
		git: m.workspace_surface_git_workbench,
		'git-history': m.workspace_surface_git_history,
		'git-compare': m.workspace_surface_git_compare,
		'pull-requests': m.workspace_surface_pull_requests,
		files: m.workspace_surface_files,
		commit: m.workspace_surface_commit,
		'chat-map': m.workspace_surface_chat_map,
	};
	const eligibleActions = $derived.by((): readonly WorkspaceWindowAddAction[] => [
		...availableSingletonKinds.map((kind) => ({
			id: `singleton:${kind}`,
			kind,
			label: openSingletonLabel(kind),
			onclick: () => openSingleton(kind),
		})),
		{
			id: 'new-terminal',
			kind: 'terminal',
			label: terminalLimitReached ? m.terminal_limit_reached() : m.workspace_new_terminal(),
			onclick: () => void createTerminal(),
			disabled: creatingTerminal || terminalLimitReached,
			busy: creatingTerminal,
		},
	]);
	const inlineActions = $derived(eligibleActions.slice(0, inlineActionCount));
	const menuActions = $derived(eligibleActions.slice(inlineActionCount));
	const showMenu = $derived(menuActions.length > 0 || unplacedTerminalSessions.length > 0);

	$effect(() => {
		const currentInlineCount = Math.min(
			eligibleActions.length,
			Math.max(
				0,
				untrack(() => inlineActionCount),
			),
		);
		const nextInlineCount = resolveWorkspaceWindowInlineAddActionCount({
			measure,
			eligibleCount: eligibleActions.length,
			currentInlineCount,
			hasPersistentMenuContent: unplacedTerminalSessions.length > 0,
		});
		if (nextInlineCount !== untrack(() => inlineActionCount)) {
			inlineActionCount = nextInlineCount;
		}
	});

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

	function openSingletonLabel(kind: PortableSingletonKind): string {
		if (kind === 'git-history') return m.workspace_open_git_history();
		if (kind === 'git-compare') return m.workspace_open_git_compare();
		if (kind === 'chat-map') return m.workspace_open_chat_map();
		return m.workspace_open_surface({ surface: singletonLabels[kind]() });
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

<div class="flex shrink-0 items-center gap-0.5" data-workspace-window-add-controls={windowId}>
	{#each inlineActions as action (action.id)}
		<button
			type="button"
			class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			aria-label={action.label}
			title={action.label}
			disabled={action.disabled}
			aria-busy={action.busy || undefined}
			data-workspace-window-add-inline={action.id}
			onclick={action.busy ? undefined : action.onclick}
		>
			<WorkspaceSurfaceIcon kind={action.kind} />
		</button>
	{/each}
	{#if showMenu}
		<DropdownMenu>
			<DropdownMenuTrigger
				class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-label={m.workspace_add_to_window()}
				title={m.workspace_add_to_window()}
				data-workspace-window-add-trigger={windowId}
			>
				<Plus class="h-3.5 w-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" class="w-64" data-workspace-window-add-menu={windowId}>
				{#each menuActions as action (action.id)}
					<DropdownMenuItem
						disabled={action.disabled || action.busy}
						aria-busy={action.busy || undefined}
						title={action.disabled ? action.label : undefined}
						onSelect={action.onclick}
					>
						<WorkspaceSurfaceIcon kind={action.kind} />
						{action.label}
					</DropdownMenuItem>
				{/each}
				{#if unplacedTerminalSessions.length > 0}
					{#if menuActions.length > 0}<DropdownMenuSeparator />{/if}
					<DropdownMenuLabel>{m.workspace_open_terminals()}</DropdownMenuLabel>
					{#each unplacedTerminalSessions as session (session.metadata.terminalId)}
						<DropdownMenuItem
							onSelect={() =>
								void workspace.openTerminalSession(session.metadata.terminalId, windowId)}
						>
							<WorkspaceSurfaceIcon kind="terminal" />
							{terminalDisplayName(session.metadata)}
						</DropdownMenuItem>
					{/each}
				{/if}
			</DropdownMenuContent>
		</DropdownMenu>
	{/if}
</div>
