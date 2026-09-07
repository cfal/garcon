<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Pencil from '@lucide/svelte/icons/pencil';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
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
	const visiblePreambles = $derived(preview?.eligiblePreambles.slice(0, 2) ?? []);
	const narrowOverflowCount = $derived(Math.max(0, selectedCount - 1));
	const wideOverflowCount = $derived(Math.max(0, selectedCount - 2));
	const unavailableCount = $derived(preview?.unavailable.length ?? 0);
	const showRetry = $derived(preview === null && !loading && retryable);
</script>

<div
	class="flex h-11 min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border bg-background px-4"
	data-slot="new-chat-preambles-row"
>
	<div
		class="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden whitespace-nowrap"
		data-slot="new-chat-preambles-content"
	>
		{#if loading}
			<Loader2
				class="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
				data-slot="new-chat-preambles-loading-icon"
				aria-hidden="true"
			/>
			<span class="min-w-0 truncate text-xs text-muted-foreground" role="status">
				{m.preamble_selection_fetching()}
			</span>
		{:else if preview === null}
			<TriangleAlert
				class="h-4 w-4 shrink-0 text-status-warning-foreground"
				data-slot="new-chat-preambles-unavailable-icon"
				aria-hidden="true"
			/>
			<span
				class="min-w-0 truncate text-xs text-muted-foreground"
				role={showRetry ? 'alert' : undefined}
			>
				{m.preamble_selection_summary_unavailable()}
			</span>
		{:else}
			<FileText
				class="h-4 w-4 shrink-0 text-muted-foreground"
				data-slot="new-chat-preambles-ready-icon"
				aria-hidden="true"
			/>
			{#if selectedCount === 0}
				<span class="min-w-0 truncate text-xs text-muted-foreground">
					{m.preamble_selection_none_will_apply()}
				</span>
			{:else}
				<span
					class="shrink-0 text-xs font-medium text-muted-foreground"
					data-slot="new-chat-preambles-label"
				>
					{m.preambles_title()}
				</span>
				<span class="shrink-0 text-xs text-muted-foreground" aria-hidden="true">·</span>
				<span class="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
					{#each visiblePreambles as preamble, index (preamble.id)}
						<svelte:boundary>
							<span
								class={[
									'min-w-0 max-w-36 shrink items-center overflow-hidden rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground',
									index === 0 ? 'inline-flex' : 'hidden sm:inline-flex',
								]}
								data-slot="new-chat-preamble-pill"
								title={preamble.title}
							>
								<span class="min-w-0 truncate">{preamble.title}</span>
							</span>
							{#snippet failed()}
								<span class="min-w-0 truncate text-xs text-muted-foreground">
									{m.preamble_selection_row_unavailable()}
								</span>
							{/snippet}
						</svelte:boundary>
					{/each}
				</span>
				{#if narrowOverflowCount > 0}
					<span
						class="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground sm:hidden"
						data-slot="new-chat-preambles-overflow-narrow"
					>
						{m.preamble_selection_and_more({ count: narrowOverflowCount })}
					</span>
				{/if}
				{#if wideOverflowCount > 0}
					<span
						class="hidden shrink-0 items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground sm:inline-flex"
						data-slot="new-chat-preambles-overflow-wide"
					>
						{m.preamble_selection_and_more({ count: wideOverflowCount })}
					</span>
				{/if}
			{/if}
			{#if unavailableCount > 0}
				<span
					class="inline-flex shrink-0 items-center text-status-warning-foreground"
					data-slot="new-chat-preambles-unavailable-count"
					role="img"
					aria-label={m.preamble_selection_unavailable_count({ count: unavailableCount })}
					title={m.preamble_selection_unavailable_count({ count: unavailableCount })}
				>
					<TriangleAlert class="h-3.5 w-3.5" aria-hidden="true" />
				</span>
			{/if}
		{/if}
	</div>
	{#if showRetry}
		<Button
			variant="ghost"
			size="icon-sm"
			class="shrink-0"
			data-slot="new-chat-preambles-preview-retry"
			aria-label={m.preamble_selection_refresh()}
			title={m.preamble_selection_refresh()}
			onclick={onRetry}
		>
			<RefreshCw class="h-4 w-4" aria-hidden="true" />
		</Button>
	{/if}
	<Button
		variant="ghost"
		size="icon-sm"
		class="shrink-0"
		data-slot="new-chat-preambles-configure"
		disabled={!configurable}
		aria-label={m.preamble_selection_edit()}
		title={m.preamble_selection_edit()}
		onclick={onEdit}
	>
		<Pencil class="h-4 w-4" aria-hidden="true" />
	</Button>
</div>
