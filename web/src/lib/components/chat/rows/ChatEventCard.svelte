<script lang="ts">
	// Shared surface primitive for all non-primary chat rows (tool, thinking,
	// permission, error, info). Centralizes variant styling and row anatomy.

	import type { Snippet } from 'svelte';

	type Variant = 'default' | 'info' | 'success' | 'warning' | 'error' | 'neutral' | 'thinking';

	interface Props {
		variant?: Variant;
		compact?: boolean;
		header?: Snippet;
		body: Snippet;
		footer?: Snippet;
		class?: string;
	}

	let {
		variant = 'default',
		compact = false,
		header,
		body,
		footer,
		class: className = ''
	}: Props = $props();

	const variantClass = $derived.by(() => {
		switch (variant) {
			case 'info':
				return 'border-status-info-border bg-status-info/20 text-status-info-foreground';
			case 'success':
				return 'border-status-success-border bg-status-success/20 text-status-success-foreground';
			case 'warning':
				return 'border-status-warning-border bg-status-warning/20 text-status-warning-foreground';
			case 'error':
				return 'border-status-error-border bg-status-error/20 text-status-error-foreground';
			case 'neutral':
				return 'border-status-neutral-border bg-status-neutral/25 text-status-neutral-foreground';
			case 'thinking':
				return 'border-border border-dotted bg-muted/50 text-foreground';
			default:
				return 'border-border bg-card text-foreground';
		}
	});

	const paddingClass = $derived(compact ? 'px-3 py-2' : 'px-3.5 py-3');
</script>

<article class="rounded-xl border shadow-sm {variantClass} {paddingClass} {className}">
	{#if header}
		<div class="mb-2 flex items-start justify-between gap-2">
			{@render header()}
		</div>
	{/if}

	<div class="min-w-0">
		{@render body()}
	</div>

	{#if footer}
		<div class="mt-3">
			{@render footer()}
		</div>
	{/if}
</article>
