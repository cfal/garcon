<script lang="ts">
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import type { DisplaySummaryPaging } from '$lib/chat/transcript/display-summary-controller.svelte.js';
	let { paging }: { paging: DisplaySummaryPaging } = $props();
	const status = $derived.by(() => {
		if (paging.error !== null) return paging.error;
		if (paging.updating) return 'Updating...';
		if (paging.stale) return 'New updates';
		return '';
	});
</script>

{#if paging.updating || paging.stale || paging.error || paging.hasPrevious || paging.hasNext}
	<div class="flex min-w-0 items-center gap-2 border-t border-border px-3 py-1 text-xs text-muted-foreground" aria-busy={paging.loading}>
		<span class="min-w-0 flex-1 break-words" role="status">{status}</span>
		{#if paging.error || paging.stale}
			<button type="button" class="flex size-8 shrink-0 items-center justify-center rounded hover:bg-muted" title={paging.error ? 'Retry' : 'Refresh'} aria-label={paging.error ? 'Retry' : 'Refresh'} disabled={paging.loading} onclick={() => void paging.retry()}><RotateCw class="size-4" /></button>
		{/if}
		{#if paging.hasPrevious || paging.hasNext}
			<button type="button" class="flex size-8 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-40" title="Previous page" aria-label="Previous page" disabled={paging.loading || !paging.hasPrevious} onclick={() => void paging.previous()}><ChevronLeft class="size-4" /></button>
			<button type="button" class="flex size-8 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-40" title="Next page" aria-label="Next page" disabled={paging.loading || !paging.hasNext} onclick={() => void paging.next()}><ChevronRight class="size-4" /></button>
		{/if}
	</div>
{/if}
