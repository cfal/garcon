<script lang="ts">
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Pencil from '@lucide/svelte/icons/pencil';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import type { PreambleSelectionProjection } from '$shared/preambles';

	interface Props {
		preview: PreambleSelectionProjection | null;
		loading: boolean;
		configurable: boolean;
		retryable: boolean;
		onEdit: () => void;
		onRetry: () => void;
	}

	let { preview, loading, configurable, retryable, onEdit, onRetry }: Props = $props();

	const selectedCount = $derived(preview?.eligiblePreambles.length ?? 0);
	const unavailableCount = $derived(preview?.unavailable.length ?? 0);
	const showRetry = $derived(preview === null && !loading && retryable);
</script>

<div
	class="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-background px-4 py-1.5 sm:py-3"
	data-slot="new-chat-preambles-row"
>
	<div class="min-w-0 flex-1 space-y-1.5">
		<span
			class="block text-xs font-medium text-muted-foreground"
			data-slot="new-chat-preambles-label"
		>
			{m.preambles_label_with_count({ count: selectedCount })}
		</span>
		{#if loading}
			<span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
				<Loader2 class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
				{m.preamble_selection_loading()}
			</span>
		{:else if preview === null}
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-xs text-muted-foreground">
					{m.preamble_selection_preview_unavailable()}
				</span>
				{#if showRetry}
					<Button
						variant="outline"
						size="sm"
						data-slot="new-chat-preambles-preview-retry"
						onclick={onRetry}
					>
						{m.preamble_selection_refresh()}
					</Button>
				{/if}
			</div>
		{:else if preview.eligiblePreambles.length === 0}
			<span class="text-xs text-muted-foreground">
				{m.preamble_selection_none_enabled()}
			</span>
		{:else}
			<div class="flex flex-wrap gap-1.5" data-slot="new-chat-preamble-pills">
				{#each preview.eligiblePreambles as preamble (preamble.id)}
					<svelte:boundary>
						<span
							class="inline-flex max-w-full items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
							data-slot="new-chat-preamble-pill"
							title={preamble.title}
						>
							<span class="truncate">{preamble.title}</span>
						</span>
						{#snippet failed()}
							<span class="text-xs text-muted-foreground">
								{m.preamble_selection_row_unavailable()}
							</span>
						{/snippet}
					</svelte:boundary>
				{/each}
			</div>
		{/if}
		{#if unavailableCount > 0}
			<p class="text-xs text-muted-foreground">
				{m.preamble_selection_unavailable_count({ count: unavailableCount })}
			</p>
		{/if}
	</div>
	<Button
		variant="ghost"
		size="icon-sm"
		data-slot="new-chat-preambles-configure"
		disabled={!configurable}
		aria-label={m.preamble_selection_edit()}
		title={m.preamble_selection_edit()}
		onclick={onEdit}
	>
		<Pencil class="h-4 w-4" aria-hidden="true" />
	</Button>
</div>
