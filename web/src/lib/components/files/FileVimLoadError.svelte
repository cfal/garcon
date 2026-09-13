<script lang="ts">
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import { Button } from '$lib/components/ui/button';
	import { getFileSessions } from '$lib/context';

	const files = getFileSessions();
</script>

<div
	role="alert"
	class="flex shrink-0 items-center gap-2 border-b border-status-error-border bg-status-error px-3 py-2 text-xs text-status-error-foreground"
>
	<span class="min-w-0 flex-1">
		Vim mode could not load.
		{#if files.hasUnloadProtectedSessions}
			Save unsaved files and wait for pending Saves before reloading.
		{:else}
			Reload to try again.
		{/if}
	</span>
	<Button
		variant="ghost"
		size="icon-sm"
		aria-label="Reload application"
		title="Reload application"
		disabled={files.hasUnloadProtectedSessions}
		onclick={() => files.reloadApplication()}
	>
		<RotateCw class="size-4" />
	</Button>
</div>
