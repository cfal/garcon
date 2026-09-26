<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';

	let {
		title,
		detail,
		subject,
		onRetry,
		action,
	}: {
		title: string;
		detail: string;
		subject?: string;
		onRetry?: () => void;
		action?: { label: string; onClick: () => void };
	} = $props();
</script>

<div class="mx-auto max-w-md text-center" role="status">
	<p class="font-medium text-foreground">{title}</p>
	<p class="mt-1 break-words text-sm text-muted-foreground">{detail}</p>
	{#if subject}
		<p class="mt-1 break-all text-xs text-muted-foreground">{subject}</p>
	{/if}
	{#if onRetry || action}
		<div class="mt-3 flex justify-center gap-2">
			{#if onRetry}
				<button
					type="button"
					class="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
					onclick={onRetry}
				>
					{m.common_retry()}
				</button>
			{/if}
			{#if action}
				<button
					type="button"
					class="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
					onclick={action.onClick}
				>
					{action.label}
				</button>
			{/if}
		</div>
	{/if}
</div>
