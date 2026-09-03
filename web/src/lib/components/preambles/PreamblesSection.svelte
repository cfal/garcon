<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { getPreambles } from '$lib/context';
	import { filterPreambles } from '$lib/preambles/preamble-filter.js';
	import type { Preamble, PreambleDefinitionInput } from '$shared/preambles';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import FileText from '@lucide/svelte/icons/file-text';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
	import PreambleFormDialog from './PreambleFormDialog.svelte';
	import PreambleRemoveDialog from './PreambleRemoveDialog.svelte';
	import PreambleRow from './PreambleRow.svelte';

	interface Props {
		active: boolean;
	}

	let { active }: Props = $props();
	const preambles = getPreambles();
	let query = $state('');
	let formOpen = $state(false);
	let editingPreamble = $state<Preamble | null>(null);
	let removePreamble = $state<Preamble | null>(null);
	let removing = $state(false);
	let removeError = $state<string | null>(null);
	let movingPreambleId = $state<string | null>(null);
	let operationError = $state<string | null>(null);
	let normalizedQuery = $derived(query.trim());
	let visiblePreambles = $derived(filterPreambles(preambles.preambles, query));

	$effect(() => {
		if (!active) return;
		void preambles.ensureLoaded().catch(() => {});
	});

	function openCreate(): void {
		editingPreamble = null;
		operationError = null;
		formOpen = true;
	}

	function openEdit(preamble: Preamble): void {
		editingPreamble = preamble;
		operationError = null;
		formOpen = true;
	}

	async function save(definition: PreambleDefinitionInput): Promise<void> {
		if (editingPreamble) await preambles.update(editingPreamble.id, definition);
		else await preambles.create(definition);
	}

	async function confirmRemove(): Promise<void> {
		if (!removePreamble || removing) return;
		removing = true;
		removeError = null;
		try {
			await preambles.remove(removePreamble.id);
			removePreamble = null;
		} catch (error) {
			removeError = error instanceof Error ? error.message : m.preambles_remove_error();
		} finally {
			removing = false;
		}
	}

	async function move(preamble: Preamble, direction: 'up' | 'down'): Promise<void> {
		if (movingPreambleId || normalizedQuery) return;
		movingPreambleId = preamble.id;
		operationError = null;
		try {
			await preambles.move(preamble.id, direction);
		} catch (error) {
			operationError = error instanceof Error ? error.message : m.preambles_reorder_error();
		} finally {
			movingPreambleId = null;
		}
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<Button onclick={openCreate} disabled={!preambles.hasLoaded}>
			<Plus class="mr-2 h-4 w-4" />
			{m.preambles_add()}
		</Button>
		{#if preambles.hasLoaded}
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => void preambles.refresh().catch(() => {})}
				disabled={preambles.isRefreshing}
				title={m.preambles_refresh()}
				aria-label={m.preambles_refresh()}
			>
				<RefreshCw class={preambles.isRefreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
			</Button>
		{/if}
	</div>

	{#if preambles.hasLoaded && preambles.preambles.length > 0}
		<div class="space-y-1.5">
			<label for="preambles-filter" class="sr-only">{m.preambles_filter_label()}</label>
			<div class="relative">
				<Search
					class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
				/>
				<input
					id="preambles-filter"
					type="search"
					bind:value={query}
					placeholder={m.preambles_filter_placeholder()}
					class="h-10 w-full rounded-md border border-input bg-background py-2 pl-9 pr-10 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
				/>
				{#if query}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						class="absolute right-1 top-1/2 -translate-y-1/2"
						onclick={() => (query = '')}
						aria-label={m.preambles_clear_filter()}
						title={m.preambles_clear_filter()}
					>
						<X class="h-4 w-4" />
					</Button>
				{/if}
			</div>
			{#if normalizedQuery}
				<p class="text-xs text-muted-foreground">{m.preambles_filter_reorder_help()}</p>
			{/if}
		</div>
	{/if}

	{#if operationError}
		<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{operationError}
		</p>
	{/if}
	{#if preambles.hasLoaded && preambles.error}
		<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{preambles.error}
		</p>
	{/if}

	{#if preambles.status === 'loading' || preambles.status === 'idle'}
		<div class="flex min-h-48 items-center justify-center text-muted-foreground" role="status">
			<Loader2 class="mr-2 h-5 w-5 animate-spin" />
			{m.preambles_loading()}
		</div>
	{:else if preambles.status === 'error' && !preambles.hasLoaded}
		<div class="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
			<CircleAlert class="h-6 w-6 text-destructive" />
			<p class="max-w-md text-sm text-muted-foreground">
				{preambles.error ?? m.preambles_load_error()}
			</p>
			<Button variant="secondary" onclick={() => void preambles.ensureLoaded().catch(() => {})}>
				{m.preambles_retry()}
			</Button>
		</div>
	{:else if preambles.preambles.length === 0}
		<div class="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
			<FileText class="h-7 w-7 text-muted-foreground" />
			<p class="text-sm font-medium text-foreground">{m.preambles_empty()}</p>
			<p class="max-w-md text-xs text-muted-foreground">{m.preambles_empty_description()}</p>
		</div>
	{:else if visiblePreambles.length === 0}
		<div class="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
			<Search class="h-7 w-7 text-muted-foreground" />
			<p class="text-sm font-medium text-foreground">{m.preambles_no_matches()}</p>
			<p class="max-w-md text-xs text-muted-foreground">{m.preambles_no_matches_description()}</p>
		</div>
	{:else}
		<div class="space-y-2" aria-live="polite">
			{#each visiblePreambles as preamble (preamble.id)}
				{@const catalogIndex = preambles.preambles.findIndex((item) => item.id === preamble.id)}
				<svelte:boundary>
					<PreambleRow
						{preamble}
						index={catalogIndex}
						total={preambles.preambles.length}
						disabled={movingPreambleId !== null}
						reorderDisabled={Boolean(normalizedQuery)}
						onEdit={() => openEdit(preamble)}
						onRemove={() => {
							removeError = null;
							removePreamble = preamble;
						}}
						onMoveUp={() => void move(preamble, 'up')}
						onMoveDown={() => void move(preamble, 'down')}
					/>
					{#snippet failed()}
						<div class="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
							{m.preambles_row_error()}
						</div>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>
	{/if}
</div>

<PreambleFormDialog
	open={formOpen}
	preamble={editingPreamble}
	onSave={save}
	onClose={() => (formOpen = false)}
/>
<PreambleRemoveDialog
	open={removePreamble !== null}
	preamble={removePreamble}
	{removing}
	error={removeError}
	onConfirm={() => void confirmRemove()}
	onClose={() => (removePreamble = null)}
/>
