<script lang="ts">
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import * as m from '$lib/paraglide/messages.js';
	import type { DisplaySummaryPaging } from '$lib/chat/transcript/display-summary-paging.js';
	let { paging }: { paging: DisplaySummaryPaging } = $props();
	const status = $derived.by(() => {
		if (paging.error !== null) return paging.error;
		if (paging.updating) return m.chat_summary_updating();
		if (paging.stale) return m.chat_summary_new_updates();
		return '';
	});
</script>

{#if paging.updating || paging.stale || paging.error || paging.hasPrevious || paging.hasNext}
	<div class="flex min-w-0 items-center gap-2 border-t border-border px-3 py-1 text-xs text-muted-foreground" aria-busy={paging.loading}>
		<span class="min-w-0 flex-1 break-words" role="status">{status}</span>
		{#if paging.error || paging.stale}
			<button type="button" class="flex size-8 shrink-0 items-center justify-center rounded hover:bg-muted" title={paging.error ? m.chat_feed_retry() : m.common_refresh()} aria-label={paging.error ? m.chat_feed_retry() : m.common_refresh()} disabled={paging.loading} onclick={() => void paging.retry()}><RotateCw class="size-4" /></button>
		{/if}
		{#if paging.hasPrevious || paging.hasNext}
			<button type="button" class="flex size-8 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-40" title={m.chat_summary_previous_page()} aria-label={m.chat_summary_previous_page()} disabled={paging.loading || !paging.hasPrevious} onclick={() => void paging.previous()}><ChevronLeft class="size-4" /></button>
			<button type="button" class="flex size-8 shrink-0 items-center justify-center rounded hover:bg-muted disabled:opacity-40" title={m.chat_summary_next_page()} aria-label={m.chat_summary_next_page()} disabled={paging.loading || !paging.hasNext} onclick={() => void paging.next()}><ChevronRight class="size-4" /></button>
		{/if}
	</div>
{/if}
