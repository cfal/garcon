<script lang="ts">
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';

	interface Props {
		isRefreshing: boolean;
		onRefresh: () => void | Promise<void>;
	}

	let { isRefreshing, onRefresh }: Props = $props();
</script>

<div
	class="flex items-center gap-2 border-b border-border bg-status-warning/10 px-3 py-2 text-xs text-foreground"
>
	<AlertTriangle class="h-4 w-4 shrink-0 text-status-warning" />
	<span class="min-w-0 flex-1">Refresh to see new changes.</span>
	<button
		type="button"
		onclick={() => void onRefresh()}
		disabled={isRefreshing}
		class="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
	>
		<RefreshCw class="h-3.5 w-3.5 {isRefreshing ? 'animate-spin' : ''}" />
		Refresh
	</button>
</div>
