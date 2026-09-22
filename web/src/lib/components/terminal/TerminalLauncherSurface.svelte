<script lang="ts">
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import { getWorkspaceCoordinator, getTerminalRegistry } from '$lib/context';
	import TerminalCreateAction from './TerminalCreateAction.svelte';
	import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';

	let { host }: { host: WorkspaceWindowId } = $props();
	const workspace = getWorkspaceCoordinator();
	const terminals = getTerminalRegistry();
	let creating = $state(false);
	let error = $state<string | null>(null);

	async function create(nodeId?: string): Promise<void> {
		if (creating) return;
		creating = true;
		error = null;
		try {
			await workspace.activateTerminalLauncher(host, nodeId);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : m.terminal_create_failed();
		} finally {
			creating = false;
		}
	}
</script>

<div class="grid h-full place-items-center bg-background p-6 text-foreground">
	<div class="flex max-w-sm flex-col items-center gap-3 text-center">
		<SquareTerminal class="h-9 w-9 text-muted-foreground" />
		<h2 class="text-sm font-semibold">{m.terminal_start()}</h2>
		{#if error}<p class="text-xs text-status-error-foreground">{error}</p>{/if}
		<TerminalCreateAction
			{terminals}
			busy={creating}
			showLabel
			defaultNodeId={workspace.terminalCreationNodeId}
			oncreate={(nodeId) => void create(nodeId)}
		/>
	</div>
</div>
