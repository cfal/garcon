<script lang="ts">
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { getPreambles } from '$lib/context';
	import {
		candidateUnavailableReason,
		projectDraftSelection,
	} from '$lib/preambles/selection-projection.js';
	import * as m from '$lib/paraglide/messages.js';
	import type {
		Preamble,
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
	const componentId = $props.id();

	$effect(() => {
		void catalog.ensureLoaded().catch(() => undefined);
	});

	const draftProjection = $derived(
		projectDraftSelection({
			draftIds,
			savedProjection: projection,
			catalog: { preambles: catalog.preambles },
			canonicalProjectPath,
		}),
	);
	const draftRowsById = $derived(new Map(draftProjection.rows.map((row) => [row.id, row])));
	const selectionIndexes = $derived(new Map(draftIds.map((id, index) => [id, index] as const)));
	const catalogIds = $derived(new Set(catalog.preambles.map((preamble) => preamble.id)));
	const missingRows = $derived(draftProjection.rows.filter((row) => !catalogIds.has(row.id)));

	function reasonLabel(reason: PreambleSelectionUnavailableReason): string {
		switch (reason) {
			case 'disabled':
				return m.preamble_selection_status_disabled();
			case 'out-of-scope':
				return m.preamble_selection_status_out_of_scope();
			case 'missing':
				return m.preamble_selection_status_missing();
		}
	}

	function toggleSelection(id: PreambleId, checked: boolean): void {
		if (checked) onAdd(id);
		else onRemove(id);
	}

	function unavailableReason(preamble: Preamble): PreambleSelectionUnavailableReason | null {
		const selectedRow = draftRowsById.get(preamble.id);
		if (selectedRow) return selectedRow.reason;
		return candidateUnavailableReason(preamble, canonicalProjectPath);
	}

	function reasonDescriptionId(preambleId: PreambleId): string {
		return `${componentId}-preamble-selection-reason-${preambleId}`;
	}
</script>

<div class="flex min-w-0 flex-col gap-3" data-slot="chat-preamble-selection-rows">
	{#if !catalog.hasLoaded}
		{#if catalog.status === 'error'}
			<div
				class="flex items-center gap-2"
				role="alert"
				data-slot="chat-preamble-selection-catalog-error"
			>
				<p class="min-w-0 flex-1 text-sm text-destructive">{m.preambles_load_error()}</p>
				<Button
					variant="outline"
					size="sm"
					onclick={() => void catalog.refresh().catch(() => undefined)}
				>
					<RefreshCw class="h-3.5 w-3.5" />
					{m.preambles_retry()}
				</Button>
			</div>
		{:else}
			<p
				class="text-sm text-muted-foreground"
				role="status"
				data-slot="chat-preamble-selection-catalog-loading"
			>
				{m.preambles_loading()}
			</p>
		{/if}
	{:else}
		{#if draftProjection.eligibleCount === 0}
			<p class="text-sm text-muted-foreground" data-slot="chat-preamble-selection-empty">
				{m.preamble_selection_none_enabled()}
			</p>
		{/if}

		<div class="flex min-w-0 flex-col gap-2" data-slot="chat-preamble-selection-catalog-rows">
			{#each catalog.preambles as preamble (preamble.id)}
				{@const selectedIndex = selectionIndexes.get(preamble.id) ?? -1}
				{@const selected = selectedIndex >= 0}
				{@const reason = unavailableReason(preamble)}
				<svelte:boundary>
					<div
						data-slot="chat-preamble-selection-row"
						class="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
					>
						<div class="min-w-0 flex-1">
							<span
								class="block break-words"
								data-slot="chat-preamble-selection-row-title"
								title={reason ? reasonLabel(reason) : undefined}
							>
								{preamble.title}
							</span>
							{#if reason}
								<span id={reasonDescriptionId(preamble.id)} class="sr-only">
									{reasonLabel(reason)}
								</span>
							{/if}
						</div>
						<span class="flex shrink-0 items-center gap-1">
							<Button
								variant="ghost"
								size="icon-sm"
								data-slot="chat-preamble-selection-move-up"
								aria-label={m.preamble_selection_move_up({ title: preamble.title })}
								disabled={disabled || !selected || selectedIndex === 0}
								onclick={() => onMove(preamble.id, 'up')}
							>
								<ArrowUp class="h-3.5 w-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								data-slot="chat-preamble-selection-move-down"
								aria-label={m.preamble_selection_move_down({ title: preamble.title })}
								disabled={disabled || !selected || selectedIndex === draftIds.length - 1}
								onclick={() => onMove(preamble.id, 'down')}
							>
								<ArrowDown class="h-3.5 w-3.5" />
							</Button>
						</span>
						<Switch
							data-slot="chat-preamble-selection-checkbox"
							checked={selected}
							disabled={disabled || (!selected && reason !== null)}
							aria-label={selected
								? m.preamble_selection_remove({ title: preamble.title })
								: m.preamble_selection_add_candidate({ title: preamble.title })}
							aria-describedby={reason ? reasonDescriptionId(preamble.id) : undefined}
							onCheckedChange={(checked) => toggleSelection(preamble.id, checked)}
						/>
					</div>
					{#snippet failed()}
						<div class="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
							{m.preamble_selection_row_unavailable()}
						</div>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>

		{#if missingRows.length > 0}
			<div class="space-y-2" data-slot="chat-preamble-selection-missing-rows">
				<p class="text-xs font-medium text-muted-foreground">
					{m.preamble_selection_retained_missing()}
				</p>
				{#each missingRows as row (row.id)}
					<svelte:boundary>
						{@const selectedIndex = selectionIndexes.get(row.id) ?? -1}
						<div
							class="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm"
							data-slot="chat-preamble-selection-missing-row"
						>
							<div class="min-w-0 flex-1">
								<span
									class="block break-words text-muted-foreground"
									data-slot="chat-preamble-selection-row-title"
								>
									{row.title ?? m.preamble_selection_status_missing()}
								</span>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={m.preamble_selection_move_up({ title: row.title ?? row.id })}
								disabled={disabled || selectedIndex === 0}
								onclick={() => onMove(row.id, 'up')}
							>
								<ArrowUp class="h-3.5 w-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={m.preamble_selection_move_down({ title: row.title ?? row.id })}
								disabled={disabled || selectedIndex === draftIds.length - 1}
								onclick={() => onMove(row.id, 'down')}
							>
								<ArrowDown class="h-3.5 w-3.5" />
							</Button>
							<Switch
								data-slot="chat-preamble-selection-checkbox"
								checked
								{disabled}
								aria-label={m.preamble_selection_remove({ title: row.title ?? row.id })}
								onCheckedChange={(checked) => {
									if (!checked) onRemove(row.id);
								}}
							/>
						</div>
						{#snippet failed()}
							<div class="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
								{m.preamble_selection_row_unavailable()}
							</div>
						{/snippet}
					</svelte:boundary>
				{/each}
			</div>
		{/if}
	{/if}
</div>
