<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import FileText from '@lucide/svelte/icons/file-text';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import { ApiError } from '$lib/api/client.js';
	import { getSnippets } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { SNIPPET_MAX_COUNT, type Snippet, type SnippetDefinitionInput } from '$shared/snippets';
	import SnippetFormDialog from './SnippetFormDialog.svelte';
	import SnippetRemoveDialog from './SnippetRemoveDialog.svelte';
	import SnippetRow from './SnippetRow.svelte';

	interface Props {
		active: boolean;
	}

	let { active }: Props = $props();
	const snippets = getSnippets();
	let formOpen = $state(false);
	let editingSnippet = $state<Snippet | null>(null);
	let removeSnippet = $state<Snippet | null>(null);
	let removing = $state(false);
	let removeError = $state<string | null>(null);
	let movingSnippetId = $state<string | null>(null);
	let operationError = $state<string | null>(null);
	const operationLocked = $derived(movingSnippetId !== null || removing || snippets.isRefreshing);

	$effect(() => {
		if (active) void snippets.ensureLoaded().catch(() => undefined);
	});

	function errorDetail(error: unknown): string {
		if (error instanceof ApiError) return error.details || error.message;
		return error instanceof Error ? error.message : String(error);
	}

	function openCreate(): void {
		if (operationLocked) return;
		editingSnippet = null;
		operationError = null;
		formOpen = true;
	}

	function openEdit(snippet: Snippet): void {
		if (operationLocked) return;
		editingSnippet = snippet;
		operationError = null;
		formOpen = true;
	}

	async function save(definition: SnippetDefinitionInput): Promise<void> {
		if (editingSnippet) await snippets.update(editingSnippet.id, definition);
		else await snippets.create(definition);
	}

	async function confirmRemove(): Promise<void> {
		if (!removeSnippet || operationLocked) return;
		removing = true;
		removeError = null;
		try {
			await snippets.remove(removeSnippet.id);
			removeSnippet = null;
		} catch (error) {
			removeError = m.snippets_remove_error({ detail: errorDetail(error) });
		} finally {
			removing = false;
		}
	}

	async function move(snippet: Snippet, direction: 'up' | 'down'): Promise<void> {
		if (operationLocked) return;
		movingSnippetId = snippet.id;
		operationError = null;
		try {
			await snippets.move(snippet.id, direction);
		} catch (error) {
			operationError = m.snippets_reorder_error({ detail: errorDetail(error) });
		} finally {
			movingSnippetId = null;
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
				onclick={() => void snippets.refresh().catch(() => undefined)}
				disabled={operationLocked}
				title={m.snippets_refresh()}
				aria-label={m.snippets_refresh()}
			>
				<RefreshCw class={snippets.isRefreshing ? 'size-4 animate-spin' : 'size-4'} />
			</Button>
		{/if}
	</div>

	{#if snippets.hasLoaded && snippets.snippets.length >= SNIPPET_MAX_COUNT}
		<p class="text-xs text-muted-foreground">{m.snippets_limit_reached()}</p>
	{/if}
	{#if operationError}
		<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
			{operationError}
		</p>
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
				onclick={() => void snippets.ensureLoaded().catch(() => undefined)}
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
			{#each snippets.snippets as snippet, index (snippet.id)}
				<svelte:boundary>
					<SnippetRow
						{snippet}
						{index}
						total={snippets.snippets.length}
						disabled={operationLocked}
						onEdit={() => openEdit(snippet)}
						onRemove={() => {
							removeError = null;
							removeSnippet = snippet;
						}}
						onMoveUp={() => void move(snippet, 'up')}
						onMoveDown={() => void move(snippet, 'down')}
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

<SnippetFormDialog
	open={formOpen}
	snippet={editingSnippet}
	onSave={save}
	onClose={() => (formOpen = false)}
/>
<SnippetRemoveDialog
	open={removeSnippet !== null}
	snippet={removeSnippet}
	{removing}
	error={removeError}
	onConfirm={() => void confirmRemove()}
	onClose={() => (removeSnippet = null)}
/>
