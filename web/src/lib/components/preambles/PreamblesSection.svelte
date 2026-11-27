<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '$lib/api/client.js';
	import { Button } from '$lib/components/ui/button';
	import { getPreambles } from '$lib/context';
	import { filterPreambles } from '$lib/preambles/preamble-filter.js';
	import {
		PREAMBLE_ERROR_CODES,
		type Preamble,
		type PreambleDefinitionInput,
	} from '$shared/preambles';
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

	type PreambleFormTarget =
		| { kind: 'closed' }
		| { kind: 'create' }
		| { kind: 'edit'; preamble: Preamble; revision: number };

	let { active }: Props = $props();
	const preambles = getPreambles();
	let query = $state('');
	let form = $state<PreambleFormTarget>({ kind: 'closed' });
	let removeTarget = $state<{ preamble: Preamble; revision: number } | null>(null);
	let removing = $state(false);
	let removeError = $state<string | null>(null);
	let catalogMutationBusy = $state(false);
	let editConflict = $state(false);
	let operationError = $state<string | null>(null);
	let operationLocked = $derived(catalogMutationBusy || preambles.isRefreshing);
	let normalizedQuery = $derived(query.trim());
	let visiblePreambles = $derived(filterPreambles(preambles.preambles, query));
	let formIsStale = $derived(
		form.kind === 'edit' &&
			(editConflict ||
				(preambles.snapshot !== null && preambles.snapshot.revision !== form.revision)),
	);

	$effect(() => {
		if (!active) return;
		untrack(() => void preambles.loadInBackground());
	});

	function openCreate(): void {
		if (operationLocked) return;
		form = { kind: 'create' };
		editConflict = false;
		operationError = null;
	}

	function openEdit(preamble: Preamble): void {
		const revision = preambles.snapshot?.revision;
		if (operationLocked || revision === undefined) return;
		form = { kind: 'edit', preamble, revision };
		editConflict = false;
		operationError = null;
	}

	function closeForm(): void {
		form = { kind: 'closed' };
		editConflict = false;
	}

	function openRemove(preamble: Preamble): void {
		const revision = preambles.snapshot?.revision;
		if (operationLocked || revision === undefined) return;
		operationError = null;
		removeError = null;
		removeTarget = { preamble, revision };
	}

	function closeRemove(): void {
		removeTarget = null;
		removeError = null;
	}

	function reportAlreadyRemoved(title: string): void {
		closeRemove();
		operationError = m.preambles_already_removed({ title });
	}

	async function save(definition: PreambleDefinitionInput): Promise<void> {
		if (form.kind === 'edit' && formIsStale) {
			editConflict = true;
			throw new Error(m.preambles_edit_stale());
		}
		if (operationLocked) {
			throw new Error(m.preambles_changed_before_write());
		}
		catalogMutationBusy = true;
		try {
			if (form.kind === 'edit') {
				await preambles.update(form.preamble.id, definition, form.revision);
			} else if (form.kind === 'create') {
				await preambles.create(definition);
			}
		} catch (error) {
			if (form.kind === 'edit' && error instanceof ApiError) {
				if (error.errorCode === PREAMBLE_ERROR_CODES.revisionConflict) {
					editConflict = true;
				} else if (error.errorCode === PREAMBLE_ERROR_CODES.notFound) {
					editConflict = true;
					throw new Error(m.preambles_already_removed({ title: form.preamble.title }), {
						cause: error,
					});
				}
			}
			throw error;
		} finally {
			catalogMutationBusy = false;
		}
	}

	async function confirmRemove(): Promise<void> {
		if (!removeTarget || operationLocked) return;
		const target = removeTarget;
		catalogMutationBusy = true;
		removing = true;
		removeError = null;
		try {
			await preambles.remove(target.preamble.id, target.revision);
			closeRemove();
		} catch (error) {
			if (error instanceof ApiError && error.errorCode === PREAMBLE_ERROR_CODES.notFound) {
				reportAlreadyRemoved(target.preamble.title);
				return;
			}
			if (
				removeTarget &&
				error instanceof ApiError &&
				error.errorCode === PREAMBLE_ERROR_CODES.revisionConflict &&
				preambles.snapshot !== null
			) {
				const refreshed = preambles.snapshot.preambles.find(
					(entry) => entry.id === target.preamble.id,
				);
				if (!refreshed) {
					reportAlreadyRemoved(target.preamble.title);
					return;
				}
				removeTarget = { preamble: refreshed, revision: preambles.snapshot.revision };
			}
			removeError = error instanceof Error ? error.message : m.preambles_remove_error();
		} finally {
			removing = false;
			catalogMutationBusy = false;
		}
	}

	async function move(preamble: Preamble, direction: 'up' | 'down'): Promise<void> {
		if (operationLocked || normalizedQuery) return;
		catalogMutationBusy = true;
		operationError = null;
		try {
			await preambles.move(preamble.id, direction);
		} catch (error) {
			operationError = error instanceof Error ? error.message : m.preambles_reorder_error();
		} finally {
			catalogMutationBusy = false;
		}
	}

	async function setEnabled(preamble: Preamble, enabled: boolean): Promise<void> {
		if (operationLocked || preamble.enabled === enabled) return;
		const revision = preambles.snapshot?.revision;
		if (revision === undefined) return;
		catalogMutationBusy = true;
		operationError = null;
		try {
			await preambles.update(
				preamble.id,
				{
					enabled,
					title: preamble.title,
					...(preamble.snippetShortName
						? { snippetShortName: preamble.snippetShortName }
						: {}),
					content: preamble.content,
					scope: preamble.scope,
					agentIds: preamble.agentIds,
					tagFilter: preamble.tagFilter,
				},
				revision,
			);
		} catch (error) {
			operationError = error instanceof Error ? error.message : m.preambles_toggle_error();
		} finally {
			catalogMutationBusy = false;
		}
	}

	async function refresh(): Promise<void> {
		if (catalogMutationBusy) return;
		operationError = null;
		await preambles.refreshInBackground();
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<Button
			onclick={openCreate}
			disabled={!preambles.hasLoaded || operationLocked}
		>
			<Plus class="mr-2 h-4 w-4" />
			{m.preambles_add()}
		</Button>
		{#if preambles.hasLoaded}
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => void refresh()}
				disabled={operationLocked}
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
			<Button variant="secondary" onclick={() => void preambles.loadInBackground()}>
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
		<div class="space-y-2">
			{#each visiblePreambles as preamble, index (preamble.id)}
				<svelte:boundary>
					<PreambleRow
						{preamble}
						{index}
						total={preambles.preambles.length}
						disabled={operationLocked}
						reorderDisabled={Boolean(normalizedQuery)}
						onEdit={() => openEdit(preamble)}
						onRemove={() => openRemove(preamble)}
						onMoveUp={() => void move(preamble, 'up')}
						onMoveDown={() => void move(preamble, 'down')}
						onEnabledChange={(enabled) => void setEnabled(preamble, enabled)}
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

{#if form.kind !== 'closed'}
	<PreambleFormDialog
		open
		preamble={form.kind === 'edit' ? form.preamble : null}
		isStale={formIsStale}
		disabled={operationLocked}
		onSave={save}
		onClose={closeForm}
	/>
{/if}
{#if removeTarget}
	<PreambleRemoveDialog
		open
		preamble={removeTarget.preamble}
		{removing}
		disabled={operationLocked}
		error={removeError}
		onConfirm={() => void confirmRemove()}
		onClose={closeRemove}
	/>
{/if}
