<script lang="ts">
	import type { Component } from 'svelte';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSub,
		DropdownMenuSubTrigger,
		DropdownMenuSubContent,
	} from '$lib/components/ui/dropdown-menu';
	import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		terminals,
		oncreate,
		mode = 'inline',
		busy = false,
		defaultNodeId = 'local',
		showLabel = false,
		icon: Icon = SquareTerminal,
		controlClass = '',
		controlStyle,
		windowId,
	}: {
		terminals: Pick<TerminalRegistry, 'hosts' | 'hasRemoteHosts' | 'canCreate'>;
		oncreate: (nodeId?: string) => void;
		mode?: 'inline' | 'menu';
		busy?: boolean;
		defaultNodeId?: string;
		showLabel?: boolean;
		icon?: Component<{ class?: string }>;
		controlClass?: string;
		controlStyle?: string;
		windowId?: string;
	} = $props();
	let open = $state(false);
	const chooseHost = $derived(terminals.hasRemoteHosts || open);
	const disabled = $derived(busy || (!chooseHost && !terminals.canCreate(defaultNodeId)));
	const buttonClass = $derived(
		controlClass ||
			`inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-disabled:opacity-50 ${showLabel ? 'px-3' : 'w-8'}`,
	);

	function create(nodeId?: string): void {
		if (busy || !terminals.canCreate(nodeId ?? defaultNodeId)) return;
		open = false;
		oncreate(nodeId);
	}
</script>

{#snippet hostItems()}
	{#each terminals.hosts as host (host.id)}
		<DropdownMenuItem
			disabled={busy || !host.available || host.full}
			onSelect={() => create(host.id)}
		>
			<SquareTerminal class="h-4 w-4" />
			<span class="min-w-0 flex-1 truncate">{host.label}</span>
			{#if !host.available || host.full}<span class="text-xs text-muted-foreground"
					>{host.full ? m.terminal_limit_reached() : m.terminal_unavailable()}</span
				>{/if}
		</DropdownMenuItem>
	{/each}
{/snippet}

{#if mode === 'menu'}
	{#if chooseHost}
		<DropdownMenuSub bind:open>
			<DropdownMenuSubTrigger disabled={busy} data-workspace-window-add-action="new-terminal">
				<SquareTerminal />{m.workspace_new_terminal()}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent class="w-64">{@render hostItems()}</DropdownMenuSubContent>
		</DropdownMenuSub>
	{:else}
		<DropdownMenuItem
			{disabled}
			aria-busy={busy || undefined}
			onSelect={() => create()}
			data-workspace-window-add-action="new-terminal"
		>
			<SquareTerminal />{m.workspace_new_terminal()}
		</DropdownMenuItem>
	{/if}
{:else if chooseHost}
	<DropdownMenu bind:open>
		<DropdownMenuTrigger
			class={buttonClass}
			style={controlStyle}
			disabled={busy}
			aria-label={m.workspace_new_terminal()}
			title={m.workspace_new_terminal()}
			data-workspace-window-add-inline={windowId ? 'new-terminal' : undefined}
			data-workspace-window-add-action={windowId ? 'new-terminal' : undefined}
		>
			<Icon class="h-4 w-4" />{#if showLabel}{m.workspace_new_terminal()}{/if}
		</DropdownMenuTrigger>
		<DropdownMenuContent align="end" class="w-64">{@render hostItems()}</DropdownMenuContent>
	</DropdownMenu>
{:else}
	<button
		type="button"
		class={buttonClass}
		style={controlStyle}
		disabled={!busy && disabled}
		aria-disabled={busy || undefined}
		aria-busy={busy || undefined}
		aria-label={m.workspace_new_terminal()}
		title={m.workspace_new_terminal()}
		data-workspace-window-add-inline={windowId ? 'new-terminal' : undefined}
		data-workspace-window-add-action={windowId ? 'new-terminal' : undefined}
		onclick={() => create()}
	>
		<Icon class="h-4 w-4" />{#if showLabel}{m.workspace_new_terminal()}{/if}
	</button>
{/if}
