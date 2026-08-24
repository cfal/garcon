<script lang="ts">
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import type { CliPresentationStyle } from '@garcon/common/cli-presentation';
	import { cliPresentationLabel } from '$lib/chat/transcript/cli-presentation-style';

	let { style, title }: { style: CliPresentationStyle; title?: string } = $props();
	const label = $derived(cliPresentationLabel(style));
	const displayTitle = $derived(title || undefined);
</script>

<div class="flex min-w-0 items-center gap-2">
	<SquareTerminal class="size-3.5 shrink-0" aria-hidden="true" />
	{#if displayTitle}<span class="sr-only">{label}</span>{/if}
	<span class="min-w-0 flex-1 truncate text-xs font-medium">{displayTitle ?? label}</span>
</div>
