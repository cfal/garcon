<script lang="ts">
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import Plus from '@lucide/svelte/icons/plus';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuLabel,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
		DropdownMenuSub,
		DropdownMenuSubContent,
		DropdownMenuSubTrigger,
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
	import type { WorkspaceWindowTabMeasure } from './workspace-window-add-layout.js';
	import { WorkspaceWindowAddMenuState } from './workspace-window-add-menu-state.svelte.js';
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

	interface WorkspaceWindowAddCommand {
		readonly id: string;
		readonly kind: PortableSingletonKind | 'terminal';
		readonly label: string;
		readonly onclick: () => void;
		readonly disabled?: boolean;
		readonly busy?: boolean;
	}
	type WorkspaceWindowAddAction =
		| WorkspaceWindowAddCommand
		| {
				readonly id: 'chat-views';
				readonly kind: 'chat-views';
				readonly label: string;
		  };
	const CHAT_VIEW_KINDS: readonly PortableSingletonKind[] = [
		'chat-map',
		'chat-canvas',
		'chat-board',
	];

	const ADD_ACTION_CONTROL_CLASS =
		'flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50 disabled:pointer-events-none disabled:opacity-50';

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
		'chat-canvas': m.workspace_surface_chat_canvas,
		'chat-board': m.workspace_surface_chat_board,
	};
	const chatViewActions = $derived(
		availableSingletonKinds.filter((kind) => CHAT_VIEW_KINDS.includes(kind)).map(singletonAction),
	);
	const eligibleActions = $derived.by((): readonly WorkspaceWindowAddAction[] => [
		...availableSingletonKinds
			.filter((kind) => !CHAT_VIEW_KINDS.includes(kind))
			.map(singletonAction),
		...(chatViewActions.length > 0
			? [{ id: 'chat-views', kind: 'chat-views', label: m.workspace_chat_views() } as const]
			: []),
		{
			id: 'new-terminal',
			kind: 'terminal',
			label: terminalLimitReached ? m.terminal_limit_reached() : m.workspace_new_terminal(),
			onclick: () => void createTerminal(),
			disabled: terminalLimitReached,
			busy: creatingTerminal,
		},
	]);
	const hasUnplacedTerminalSessions = $derived(unplacedTerminalSessions.length > 0);
	const menuState = new WorkspaceWindowAddMenuState({
		get windowId() {
			return windowId;
		},
		get measure() {
			return measure;
		},
		get actionIds() {
			return eligibleActions.map((action) => action.id);
		},
		get hasUnplacedTerminalSessions() {
			return hasUnplacedTerminalSessions;
		},
	});
	const inlineActions = $derived(eligibleActions.slice(0, menuState.inlineActionCount));
	const menuActions = $derived(eligibleActions.slice(menuState.inlineActionCount));
	const showOverflowMenu = $derived(menuActions.length > 0);

	function singletonAction(kind: PortableSingletonKind): WorkspaceWindowAddCommand {
		return {
			id: `singleton:${kind}`,
			kind,
			label: openSingletonLabel(kind),
			onclick: () => openSingleton(kind),
		};
	}

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
		if (kind === 'chat-canvas') return m.workspace_open_chat_canvas();
		if (kind === 'chat-board') return m.workspace_open_chat_board();
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

{#snippet addActionMenuItem(action: WorkspaceWindowAddCommand, group?: string)}
	<DropdownMenuItem
		data-workspace-window-add-action={action.id}
		data-workspace-window-add-group={group}
		disabled={action.disabled || action.busy}
		aria-busy={action.busy || undefined}
		title={action.disabled ? action.label : undefined}
		onSelect={action.onclick}
	>
		<WorkspaceSurfaceIcon kind={action.kind} />
		{action.label}
	</DropdownMenuItem>
{/snippet}

{#snippet chatViewMenuItems()}
	{#each chatViewActions as action (action.id)}
		{@render addActionMenuItem(action, 'chat-views')}
	{/each}
{/snippet}

{#snippet unplacedTerminalMenuItems()}
	<DropdownMenuLabel>{m.workspace_open_terminals()}</DropdownMenuLabel>
	{#each unplacedTerminalSessions as session (session.metadata.terminalId)}
		<DropdownMenuItem
			onSelect={() => void workspace.openTerminalSession(session.metadata.terminalId, windowId)}
		>
			<WorkspaceSurfaceIcon kind="terminal" />
			{terminalDisplayName(session.metadata)}
		</DropdownMenuItem>
	{/each}
{/snippet}

<div
	bind:this={menuState.controlsElement}
	class="flex shrink-0 items-center gap-[2px]"
	data-workspace-window-add-controls={windowId}
>
	{#each inlineActions as action (action.id)}
		{#if action.kind === 'chat-views'}
			<DropdownMenu>
				<DropdownMenuTrigger
					class={ADD_ACTION_CONTROL_CLASS}
					aria-label={action.label}
					title={action.label}
					data-workspace-window-add-action={action.id}
					data-workspace-window-add-inline={action.id}
					data-workspace-window-add-chat-views-trigger={windowId}
				>
					<MessagesSquare class="h-3.5 w-3.5" />
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					class="w-64"
					data-workspace-window-add-menu={windowId}
					data-workspace-window-chat-views-menu={windowId}
				>
					{@render chatViewMenuItems()}
				</DropdownMenuContent>
			</DropdownMenu>
		{:else if action.kind === 'terminal' && hasUnplacedTerminalSessions}
			<DropdownMenu>
				<DropdownMenuTrigger
					class={ADD_ACTION_CONTROL_CLASS}
					aria-label={m.workspace_terminal_actions()}
					title={m.workspace_terminal_actions()}
					data-workspace-window-add-action={action.id}
					data-workspace-window-add-terminal-trigger={windowId}
				>
					<WorkspaceSurfaceIcon kind="terminal" />
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					class="w-64"
					data-workspace-window-add-menu={windowId}
					data-workspace-window-add-terminal-menu={windowId}
				>
					{@render addActionMenuItem(action)}
					<DropdownMenuSeparator />
					{@render unplacedTerminalMenuItems()}
				</DropdownMenuContent>
			</DropdownMenu>
		{:else}
			<button
				type="button"
				class={ADD_ACTION_CONTROL_CLASS}
				aria-label={action.label}
				title={action.label}
				disabled={action.disabled}
				aria-disabled={action.busy || undefined}
				aria-busy={action.busy || undefined}
				data-workspace-window-add-action={action.id}
				data-workspace-window-add-inline={action.id}
				onclick={action.disabled || action.busy ? undefined : action.onclick}
			>
				<WorkspaceSurfaceIcon kind={action.kind} />
			</button>
		{/if}
	{/each}
	{#if showOverflowMenu}
		<DropdownMenu bind:open={menuState.overflowMenuOpen}>
			<DropdownMenuTrigger
				class={ADD_ACTION_CONTROL_CLASS}
				aria-label={m.workspace_add_to_window()}
				title={m.workspace_add_to_window()}
				data-workspace-window-add-trigger={windowId}
			>
				<Plus class="h-3.5 w-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				bind:ref={menuState.overflowMenuContent}
				align="end"
				class="w-64"
				data-workspace-window-add-menu={windowId}
				onOpenAutoFocus={(event) => menuState.handleOpenAutoFocus(event)}
				onCloseAutoFocus={(event) => menuState.handleCloseAutoFocus(event)}
			>
				{#each menuActions as action (action.id)}
					{#if action.kind === 'chat-views'}
						<DropdownMenuSub>
							<DropdownMenuSubTrigger data-workspace-window-add-action={action.id}>
								<MessagesSquare />
								{action.label}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent
								class="w-64"
								data-workspace-window-add-menu={windowId}
								data-workspace-window-chat-views-menu={windowId}
							>
								{@render chatViewMenuItems()}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					{:else}
						{@render addActionMenuItem(action)}
					{/if}
				{/each}
				{#if hasUnplacedTerminalSessions}
					<DropdownMenuSeparator />
					{@render unplacedTerminalMenuItems()}
				{/if}
			</DropdownMenuContent>
		</DropdownMenu>
	{/if}
</div>
