<script lang="ts">
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/components/ui/button';
	import { getWorkspaceCoordinator } from '$lib/context';
	import type { HostId } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';

	let { host }: { host: HostId } = $props();
	const workspace = getWorkspaceCoordinator();
	let creating = $state(false);
	let error = $state<string | null>(null);

	async function create(): Promise<void> {
		if (creating) return;
		creating = true;
		error = null;
		try {
			await workspace.activateTerminalLauncher(host);
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
		<Button onclick={() => void create()} disabled={creating}>
			{#if creating}<LoaderCircle class="h-4 w-4 animate-spin" />{:else}<SquareTerminal
					class="h-4 w-4"
				/>{/if}
			{creating ? m.terminal_creating() : m.workspace_new_terminal()}
		</Button>
	</div>
</div>
