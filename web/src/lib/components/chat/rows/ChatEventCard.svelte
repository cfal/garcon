<script lang="ts">
	// Shared surface primitive for all non-primary chat rows (tool, thinking,
	// permission, error, info). Centralizes variant styling and row anatomy.

	import type { Snippet } from 'svelte';
	import {
		chatEventCardSurfaceClass,
		type ChatEventCardVariant,
	} from '$lib/chat/transcript/chat-event-card-style';
	import { cn } from '$lib/utils/cn';

	interface Props {
		variant?: ChatEventCardVariant;
		compact?: boolean;
		header?: Snippet;
		// Omitted while a disclosure body is hidden so the card does not
		// reserve the header gap for content it is not showing.
		body?: Snippet;
		footer?: Snippet;
		class?: string;
	}

	let {
		variant = 'default',
		compact = false,
		header,
		body,
		footer,
		class: className = '',
	}: Props = $props();

	const variantClass = $derived(chatEventCardSurfaceClass(variant));

	const paddingClass = $derived(compact ? 'px-3 py-2' : 'px-3.5 py-3');
</script>

<article class={cn('rounded-xl border shadow-sm', variantClass, paddingClass, className)}>
	{#if header}
		<div class={cn('flex items-start justify-between gap-2', body && 'mb-2')}>
			{@render header()}
		</div>
	{/if}

	{#if body}
		<div class="min-w-0">
			{@render body()}
		</div>
	{/if}

	{#if footer}
		<div class="mt-3">
			{@render footer()}
		</div>
	{/if}
</article>
