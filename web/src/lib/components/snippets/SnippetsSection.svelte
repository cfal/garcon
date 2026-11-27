<script lang="ts">
	import { untrack } from 'svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import FileText from '@lucide/svelte/icons/file-text';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import { ApiError } from '$lib/api/client.js';
	import { getSnippets } from '$lib/context';
	import { searchSnippets } from '$lib/snippets/search-snippets.js';
	import { snippetErrorDetail } from '$lib/snippets/snippet-expansion-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import {
		SNIPPET_ERROR_CODES,
		SNIPPET_MAX_COUNT,
		type Snippet,
		type SnippetDefinitionInput,
	} from '$shared/snippets';
	import SnippetFormDialog from './SnippetFormDialog.svelte';
	import SnippetRemoveDialog from './SnippetRemoveDialog.svelte';
	import SnippetRow from './SnippetRow.svelte';
	import SnippetSearchField from './SnippetSearchField.svelte';

	interface Props {
		active: boolean;
	}

	type SnippetFormTarget =
		| { kind: 'closed' }
		| { kind: 'create' }
		| { kind: 'edit'; snippet: Snippet; revision: number };

	let { active }: Props = $props();
	const snippets = getSnippets();
	let query = $state('');
	const filteredSnippets = $derived(
		searchSnippets(snippets.snippets, query, (snippet) => snippet.template),
	);
	let form = $state<SnippetFormTarget>({ kind: 'closed' });
	let editRemoved = $state(false);
	let removeTarget = $state<{ snippet: Snippet; revision: number } | null>(null);
	let removing = $state(false);
	let removeError = $state<string | null>(null);
	let operationError = $state<string | null>(null);
	const operationLocked = $derived(removing || snippets.isRefreshing);

	$effect(() => {
		if (active) untrack(() => void snippets.loadInBackground());
	});

	function openCreate(): void {
		if (operationLocked) return;
		editRemoved = false;
		operationError = null;
		form = { kind: 'create' };
	}

	function openEdit(snippet: Snippet): void {
		const revision = snippets.snapshot?.revision;
		if (operationLocked || revision === undefined) return;
		editRemoved = false;
		operationError = null;
		form = { kind: 'edit', snippet, revision };
	}

	function closeForm(): void {
		editRemoved = false;
		form = { kind: 'closed' };
	}

	function openRemove(snippet: Snippet): void {
		const revision = snippets.snapshot?.revision;
		if (operationLocked || revision === undefined) return;
		operationError = null;
		removeError = null;
		removeTarget = { snippet, revision };
	}

	function closeRemove(): void {
		removeTarget = null;
		removeError = null;
	}

	function rejectRemovedEdit(targetId: string, name: string, cause: ApiError): never {
		// Fence the flag to the same target so a form retargeted mid-save stays editable.
		if (form.kind === 'edit' && form.snippet.id === targetId) editRemoved = true;
		throw new Error(m.snippets_already_removed({ name }), { cause });
	}

	function reportAlreadyRemoved(name: string): void {
		closeRemove();
		operationError = m.snippets_already_removed({ name });
	}

	async function save(definition: SnippetDefinitionInput): Promise<void> {
		if (form.kind === 'edit' && editRemoved) {
			throw new Error(m.snippets_already_removed({ name: form.snippet.shortName }));
		}
		if (operationLocked) {
			throw new Error(m.snippets_changed_before_write());
		}
		if (form.kind === 'edit') {
			const targetId = form.snippet.id;
			const targetShortName = form.snippet.shortName;
			try {
				await snippets.update(targetId, definition, form.revision);
			} catch (error) {
				if (error instanceof ApiError && error.errorCode === SNIPPET_ERROR_CODES.notFound) {
					rejectRemovedEdit(targetId, targetShortName, error);
				}
				// Advance the target revision in place on 409 so an explicit retry uses the refreshed catalog without resetting the draft.
				if (
					form.kind === 'edit' &&
					form.snippet.id === targetId &&
					error instanceof ApiError &&
					error.errorCode === SNIPPET_ERROR_CODES.revisionConflict &&
					snippets.snapshot !== null
				) {
					const refreshed = snippets.snapshot.snippets.find((entry) => entry.id === targetId);
					if (!refreshed) rejectRemovedEdit(targetId, targetShortName, error);
					form.revision = snippets.snapshot.revision;
				}
				throw error;
			}
		} else if (form.kind === 'create') {
			await snippets.create(definition);
		}
	}

	async function confirmRemove(): Promise<void> {
		if (!removeTarget || operationLocked) return;
		const target = removeTarget;
		removing = true;
		removeError = null;
		try {
			await snippets.remove(target.snippet.id, target.revision);
			closeRemove();
		} catch (error) {
			if (error instanceof ApiError && error.errorCode === SNIPPET_ERROR_CODES.notFound) {
				reportAlreadyRemoved(target.snippet.shortName);
				return;
			}
			if (
				removeTarget &&
				error instanceof ApiError &&
				error.errorCode === SNIPPET_ERROR_CODES.revisionConflict &&
				snippets.snapshot !== null
			) {
				const refreshed = snippets.snapshot.snippets.find(
					(entry) => entry.id === target.snippet.id,
				);
				if (!refreshed) {
					reportAlreadyRemoved(target.snippet.shortName);
					return;
				}
				removeTarget = { snippet: refreshed, revision: snippets.snapshot.revision };
			}
			removeError = m.snippets_remove_error({ detail: snippetErrorDetail(error) });
		} finally {
			removing = false;
		}
	}
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between gap-2">
		<Button
			onclick={openCreate}
			disabled={operationLocked ||
				!snippets.hasLoaded ||
				snippets.snippets.length >= SNIPPET_MAX_COUNT}
		>
			<Plus class="mr-2 size-4" />
			{m.snippets_add()}
		</Button>
		{#if snippets.hasLoaded}
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => {
					operationError = null;
					void snippets.refreshInBackground();
				}}
				disabled={operationLocked}
				title={m.snippets_refresh()}
				aria-label={m.snippets_refresh()}
			>
				<RefreshCw class={snippets.isRefreshing ? 'size-4 animate-spin' : 'size-4'} />
			</Button>
		{/if}
	</div>

	<SnippetSearchField bind:value={query} />

	{#if operationError}
		<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{operationError}
		</p>
	{/if}
	{#if snippets.hasLoaded && snippets.snippets.length >= SNIPPET_MAX_COUNT}
		<p class="text-xs text-muted-foreground">{m.snippets_limit_reached()}</p>
	{/if}
	{#if snippets.hasLoaded && snippets.error}
		<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{snippets.error}
		</p>
	{/if}

	{#if snippets.status === 'loading' || snippets.status === 'idle'}
		<div class="flex min-h-48 items-center justify-center text-muted-foreground" role="status">
			<Loader2 class="mr-2 size-5 animate-spin" />
			{m.snippets_loading()}
		</div>
	{:else if snippets.status === 'error' && !snippets.hasLoaded}
		<div class="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
			<CircleAlert class="size-6 text-destructive" />
			<p class="max-w-md text-sm text-muted-foreground">
				{snippets.error ?? m.snippets_load_error()}
			</p>
			<Button
				variant="secondary"
				onclick={() => void snippets.loadInBackground()}
			>
				{m.snippets_retry()}
			</Button>
		</div>
	{:else if snippets.snippets.length === 0}
		<div class="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
			<FileText class="size-7 text-muted-foreground" />
			<p class="text-sm font-medium text-foreground">{m.snippets_empty()}</p>
		</div>
	{:else}
		<div class="space-y-2" aria-live="polite">
			{#if filteredSnippets.length === 0}
				<p class="py-8 text-center text-sm text-muted-foreground">{m.snippets_search_empty()}</p>
			{/if}
			{#each filteredSnippets as snippet (snippet.id)}
				<svelte:boundary>
					<SnippetRow
						{snippet}
						disabled={operationLocked}
						onEdit={() => openEdit(snippet)}
						onRemove={() => openRemove(snippet)}
					/>
					{#snippet failed()}
						<div class="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
							{m.snippets_load_error()}
						</div>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>
	{/if}
</div>

{#if form.kind !== 'closed'}
	<SnippetFormDialog
		open
		snippet={form.kind === 'edit' ? form.snippet : null}
		disabled={operationLocked || editRemoved}
		onSave={save}
		onClose={closeForm}
	/>
{/if}
{#if removeTarget}
	<SnippetRemoveDialog
		open
		snippet={removeTarget.snippet}
		{removing}
		disabled={operationLocked}
		error={removeError}
		onConfirm={() => void confirmRemove()}
		onClose={closeRemove}
	/>
{/if}
