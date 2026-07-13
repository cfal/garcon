<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import MoveRight from '@lucide/svelte/icons/move-right';
	import Focus from '@lucide/svelte/icons/scan';
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
	import type { HostId, PortableSingletonKind } from '$lib/workspace/surface-types.js';
	import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
	import * as m from '$lib/paraglide/messages.js';

	let { host }: { host: HostId } = $props();
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
	const labels: Record<PortableSingletonKind, string> = {
		git: m.workspace_surface_git_workbench(),
		'pull-requests': m.workspace_surface_pull_requests(),
		files: m.workspace_surface_files(),
		'quick-git': m.workspace_surface_quick_git(),
	};

	function placementOf(surfaceId: string): HostId | null {
		const snapshot = workspace.layout.snapshot;
		if (snapshot.main.order.includes(surfaceId)) return 'main';
		if (snapshot.sidebar.order.includes(surfaceId)) return 'sidebar';
		return null;
	}

	function canOffer(kind: PortableSingletonKind): boolean {
		return (
			kind !== 'pull-requests' ||
			!ghCapability.hasChecked ||
			ghCapability.available ||
			Boolean(workspace.layout.surface('singleton:pull-requests'))
		);
	}

	async function createTerminal(): Promise<void> {
		try {
			await workspace.createTerminal(host);
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : m.terminal_create_failed());
		}
	}
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		aria-label={host === 'main' ? m.workspace_add_main_view() : m.workspace_add_sidebar_view()}
		title={m.workspace_add_view()}
	>
		<Plus class="h-4 w-4" />
	</DropdownMenuTrigger>
	<DropdownMenuContent align="end" class="w-64">
		<DropdownMenuLabel
			>{host === 'main' ? m.workspace_main_view() : m.workspace_sidebar_view()}</DropdownMenuLabel
		>
		<DropdownMenuItem
			disabled={terminals.orderedSessions.length >= TERMINAL_SESSION_LIMIT ||
				terminals.listStatus !== 'ready'}
			onclick={() => void createTerminal()}
		>
			<SquareTerminal />
			{m.workspace_new_terminal()}
		</DropdownMenuItem>
		<DropdownMenuSeparator />
		{#each singletonKinds as kind (kind)}
			{#if canOffer(kind)}
				{@const surfaceId = `singleton:${kind}`}
				{@const placement = placementOf(surfaceId)}
				<DropdownMenuItem onclick={() => void workspace.openSingleton(kind, host)}>
					<Focus />
					{placement
						? m.workspace_focus_surface({ surface: labels[kind], location: placement })
						: m.workspace_open_surface({ surface: labels[kind] })}
				</DropdownMenuItem>
				{#if placement && placement !== host}
					<DropdownMenuItem onclick={() => void workspace.moveSurface(surfaceId, host)}>
						<MoveRight />
						{m.workspace_move_surface_here({ surface: labels[kind] })}
					</DropdownMenuItem>
				{/if}
			{/if}
		{/each}
		{#if terminals.orderedSessions.length > 0}
			<DropdownMenuSeparator />
			<DropdownMenuLabel>{m.workspace_open_terminals()}</DropdownMenuLabel>
			{#each terminals.orderedSessions as item (item.metadata.terminalId)}
				{@const surfaceId = `terminal:${item.metadata.terminalId}`}
				{@const placement = placementOf(surfaceId)}
				<DropdownMenuItem
					onclick={() => void workspace.openTerminalSession(item.metadata.terminalId, host)}
				>
					<Focus />
					{placement
						? m.workspace_focus_surface({
								surface: m.workspace_surface_terminal_number({
									number: item.metadata.displaySequence,
								}),
								location: placement,
							})
						: m.workspace_surface_terminal_number({ number: item.metadata.displaySequence })}
				</DropdownMenuItem>
				{#if placement && placement !== host}
					<DropdownMenuItem onclick={() => void workspace.moveSurface(surfaceId, host)}>
						<MoveRight />
						{m.workspace_move_surface_here({
							surface: m.workspace_surface_terminal_number({
								number: item.metadata.displaySequence,
							}),
						})}
					</DropdownMenuItem>
				{/if}
			{/each}
		{/if}
	</DropdownMenuContent>
</DropdownMenu>
