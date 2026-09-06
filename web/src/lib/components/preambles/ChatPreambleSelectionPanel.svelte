<script lang="ts">
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import { getPreambles } from '$lib/context';
	import {
		candidateUnavailableReason,
		projectDraftSelection,
	} from '$lib/preambles/selection-projection.js';
	import * as m from '$lib/paraglide/messages.js';
	import type {
		PreambleId,
		PreambleSelectionProjection,
		PreambleSelectionUnavailableReason,
	} from '$shared/preambles';

	interface Props {
		draftIds: readonly PreambleId[];
		projection: PreambleSelectionProjection | null;
		canonicalProjectPath: string;
		disabled?: boolean;
		onMove: (id: PreambleId, direction: 'up' | 'down') => void;
		onRemove: (id: PreambleId) => void;
		onAdd: (id: PreambleId) => void;
	}

	let {
		draftIds,
		projection,
		canonicalProjectPath,
		disabled = false,
		onMove,
		onRemove,
		onAdd,
	}: Props = $props();

	const catalog = getPreambles();

	let showCandidates = $state(false);

	$effect(() => {
		void catalog.ensureLoaded().catch(() => undefined);
	});

	const projected = $derived(projectDraftSelection({
		draftIds,
		savedProjection: projection,
		catalog: { preambles: catalog.preambles },
		canonicalProjectPath,
	}));
	const candidates = $derived(
		catalog.preambles
			.filter((preamble) => !draftIds.includes(preamble.id))
			.map((preamble) => ({
				id: preamble.id,
				title: preamble.title,
				reason: candidateUnavailableReason(preamble, canonicalProjectPath),
			})),
	);

	function reasonLabel(reason: PreambleSelectionUnavailableReason): string {
		if (reason === 'disabled') return m.preamble_selection_status_disabled();
		if (reason === 'out-of-scope') return m.preamble_selection_status_out_of_scope();
		return m.preamble_selection_status_missing();
	}
</script>

<div class="flex min-w-0 flex-col gap-2" data-slot="chat-preamble-selection-rows">
	{#if projected.eligibleCount === 0}
		<p class="text-sm text-muted-foreground" data-slot="chat-preamble-selection-empty">
			{m.preamble_selection_none_enabled()}
		</p>
	{/if}
	{#each projected.rows as row, index (row.id)}
		<svelte:boundary>
			<div
				data-slot="chat-preamble-selection-row"
				class="flex min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm"
			>
				<span class="min-w-0 flex-1 break-words" data-slot="chat-preamble-selection-row-title">
					{row.title ?? m.preamble_selection_status_missing()}
				</span>
				{#if row.reason}
					<span
						data-slot="chat-preamble-selection-row-status"
						class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
					>
						{reasonLabel(row.reason)}
					</span>
				{/if}
				<span class="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon-sm"
						data-slot="chat-preamble-selection-move-up"
						aria-label={m.preamble_selection_move_up({ title: row.title ?? row.id })}
						disabled={disabled || index === 0}
						onclick={() => onMove(row.id, 'up')}
					>
						<ArrowUp class="h-3.5 w-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						data-slot="chat-preamble-selection-move-down"
						aria-label={m.preamble_selection_move_down({ title: row.title ?? row.id })}
						disabled={disabled || index === projected.rows.length - 1}
						onclick={() => onMove(row.id, 'down')}
					>
						<ArrowDown class="h-3.5 w-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						data-slot="chat-preamble-selection-remove"
						aria-label={m.preamble_selection_remove({ title: row.title ?? row.id })}
						disabled={disabled}
						onclick={() => onRemove(row.id)}
					>
						<X class="h-3.5 w-3.5" />
					</Button>
				</span>
			</div>
			{#snippet failed()}
				<div class="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
					{m.preamble_selection_row_unavailable()}
				</div>
			{/snippet}
		</svelte:boundary>
	{/each}

	<Button
		variant="ghost"
		size="sm"
		class="self-start"
		data-slot="chat-preamble-selection-toggle-candidates"
		disabled={disabled}
		onclick={() => (showCandidates = !showCandidates)}
	>
		<Plus class="h-3.5 w-3.5" />
		{m.preamble_selection_add()}
	</Button>

	{#if showCandidates}
		<div class="flex min-w-0 flex-col gap-2" data-slot="chat-preamble-selection-candidates">
			{#if candidates.length === 0}
				<p class="text-sm text-muted-foreground" data-slot="chat-preamble-selection-no-candidates">
					{m.preamble_selection_no_candidates()}
				</p>
			{:else}
				{#each candidates as candidate (candidate.id)}
					<svelte:boundary>
						<div
							data-slot="chat-preamble-selection-candidate"
							class="flex min-w-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
						>
							<span class="min-w-0 flex-1 break-words" data-slot="chat-preamble-selection-candidate-title">
								{candidate.title}
							</span>
							{#if candidate.reason}
								<span
									data-slot="chat-preamble-selection-candidate-status"
									class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
								>
									{reasonLabel(candidate.reason)}
								</span>
							{/if}
							<Button
								variant="ghost"
								size="icon-sm"
								data-slot="chat-preamble-selection-candidate-add"
								aria-label={m.preamble_selection_add_candidate({ title: candidate.title })}
								disabled={disabled || candidate.reason !== null}
								onclick={() => onAdd(candidate.id)}
							>
								<Plus class="h-3.5 w-3.5" />
							</Button>
						</div>
						{#snippet failed()}
							<div class="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
								{m.preamble_selection_row_unavailable()}
							</div>
						{/snippet}
					</svelte:boundary>
				{/each}
			{/if}
		</div>
	{/if}
</div>
