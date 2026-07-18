<script lang="ts">
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';

	let {
		message,
		refreshLabel,
		isRefreshing,
		refreshError = null,
		onRefresh,
	}: {
		message: string;
		refreshLabel: string;
		isRefreshing: boolean;
		refreshError?: string | null;
		onRefresh: () => void | Promise<void>;
	} = $props();
</script>

<div
	class="flex shrink-0 items-center gap-2 border-b border-status-warning-border bg-status-warning/10 px-3 py-2 text-xs text-foreground"
	data-refresh-required-banner
>
	<AlertTriangle class="h-4 w-4 shrink-0 text-status-warning-foreground" />
	<div class="min-w-0 flex-1">
		<p aria-live="polite">{message}</p>
		{#if refreshError}
			<p class="mt-0.5 text-status-error-foreground" role="alert">{refreshError}</p>
		{/if}
	</div>
	<Button
		variant="outline"
		size="sm"
		class="h-7 shrink-0 px-2 text-xs"
		onclick={() => void onRefresh()}
		disabled={isRefreshing}
	>
		<RefreshCw class="h-3.5 w-3.5 {isRefreshing ? 'animate-spin' : ''}" />
		{refreshLabel}
	</Button>
</div>
