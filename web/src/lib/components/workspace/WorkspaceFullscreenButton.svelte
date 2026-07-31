<script lang="ts">
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import { getWorkspaceCoordinator } from '$lib/context';
	import type { HostId } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';

	let { host }: { host: HostId } = $props();
	const workspace = getWorkspaceCoordinator();
	const fullscreen = $derived(workspace.layout.snapshot.fullscreenHost === host);
	const label = $derived(fullscreen ? m.workspace_exit_fullscreen() : m.workspace_fullscreen());
</script>

<button
	type="button"
	class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
	aria-label={label}
	aria-pressed={fullscreen}
	title={label}
	data-workspace-fullscreen-toggle={host}
	onclick={() => void workspace.toggleFullscreen(host)}
>
	{#if fullscreen}
		<Minimize2 class="size-4" />
	{:else}
		<Maximize2 class="size-4" />
	{/if}
</button>
