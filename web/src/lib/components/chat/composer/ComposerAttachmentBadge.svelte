<script lang="ts">
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import * as m from '$lib/paraglide/messages.js';

	let { count }: { count: number } = $props();
	let label = $derived(m.chat_composer_expanded_attachment_count({ count }));
</script>

{#if count > 0}
	<div class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title={label}>
		<span class="sr-only">{label}</span>
		<Paperclip class="size-3.5" aria-hidden="true" />
		<span aria-hidden="true">{count}</span>
	</div>
{/if}
