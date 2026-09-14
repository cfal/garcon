<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
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
		{m.editor_vim_load_failed()}
		{#if files.hasUnloadProtectedSessions}
			{m.editor_vim_reload_blocked()}
		{:else}
			{m.editor_vim_reload_hint()}
		{/if}
	</span>
	<Button
		variant="ghost"
		size="icon-sm"
		aria-label={m.common_reload_application()}
		title={m.common_reload_application()}
		disabled={files.hasUnloadProtectedSessions}
		onclick={() => files.reloadApplication()}
	>
		<RotateCw class="size-4" />
	</Button>
</div>
