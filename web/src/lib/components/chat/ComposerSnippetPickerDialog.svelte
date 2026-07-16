<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import Search from '@lucide/svelte/icons/search';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import * as Dialog from '$lib/components/ui/dialog';
	import { getSnippets } from '$lib/context';
	import { snippetPreview } from '$lib/snippets/snippet-presentation.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { Snippet } from '$shared/snippets';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onSelect: (snippet: Snippet) => void;
		onEditSnippets: () => void;
		onRequestComposerFocus: () => void;
	}

	let {
		open,
		onOpenChange,
		onSelect,
		onEditSnippets,
		onRequestComposerFocus,
	}: Props = $props();
	const snippets = getSnippets();
	let query = $state('');
	let restoreComposerFocus = true;
	const searchIndex = $derived(
		snippets.snippets.map((snippet) => ({
			snippet,
			searchText: `${snippet.shortName}\n${snippet.template}`.toLowerCase(),
		})),
	);

	const filteredSnippets = $derived.by(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return snippets.snippets;
		return searchIndex
			.filter((entry) => entry.searchText.includes(normalized))
			.map((entry) => entry.snippet);
	});

	$effect(() => {
		if (!open) query = '';
	});

	function selectSnippet(snippet: Snippet): void {
		restoreComposerFocus = false;
		onOpenChange(false);
		queueMicrotask(() => onSelect(snippet));
	}

	function editSnippets(): void {
		restoreComposerFocus = false;
		onOpenChange(false);
		queueMicrotask(onEditSnippets);
	}

	function handleCloseAutoFocus(event: Event): void {
		event.preventDefault();
		if (restoreComposerFocus) queueMicrotask(onRequestComposerFocus);
		restoreComposerFocus = true;
	}

	function retryLoad(): void {
		void snippets.refresh({ initial: true }).catch(() => undefined);
	}
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content
		class="top-[var(--app-viewport-center-y)] flex h-[min(42rem,calc(var(--app-height)-1rem))] w-[calc(100vw-1rem)] max-w-lg flex-col gap-0 overflow-hidden p-0"
		showCloseButton={true}
		onCloseAutoFocus={handleCloseAutoFocus}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 pr-12">
			<Dialog.Title>{m.snippets_picker_title()}</Dialog.Title>
			<Dialog.Description>{m.snippets_picker_description()}</Dialog.Description>
		</Dialog.Header>

		<div class="shrink-0 border-b border-border px-4 py-3">
			<label class="sr-only" for="snippet-picker-search">{m.snippets_search_label()}</label>
			<div class="relative">
				<Search
					class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<input
					id="snippet-picker-search"
					bind:value={query}
					type="search"
					placeholder={m.snippets_search_placeholder()}
					class="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
				/>
			</div>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto p-2">
			{#if snippets.status === 'loading' && !snippets.hasLoaded}
				<p class="px-3 py-8 text-center text-sm text-muted-foreground">{m.snippets_loading()}</p>
			{:else if snippets.status === 'error' && !snippets.hasLoaded}
				<div class="flex flex-col items-center gap-3 px-3 py-8 text-center">
					<p class="text-sm text-destructive">{m.snippets_load_error()}</p>
					<button
						type="button"
						onclick={retryLoad}
						class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
					>
						<RefreshCw class="mr-2 inline size-4" />
						{m.snippets_retry()}
					</button>
				</div>
			{:else if filteredSnippets.length === 0}
				<p class="px-3 py-8 text-center text-sm text-muted-foreground">
					{query.trim() ? m.snippets_search_empty() : m.snippets_empty()}
				</p>
			{:else}
				<div class="space-y-1">
					{#each filteredSnippets as snippet (snippet.id)}
						<svelte:boundary>
							<button
								type="button"
								onclick={() => selectSnippet(snippet)}
								class="flex min-h-14 w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
							>
								<FileText class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								<span class="min-w-0">
									<span class="block truncate text-sm font-medium"
										>/snippet {snippet.shortName}</span
									>
									<span class="block truncate text-xs text-muted-foreground">
										{snippetPreview(snippet)}
									</span>
								</span>
							</button>
							{#snippet failed()}
								<div class="px-3 py-2 text-sm text-destructive">{m.snippets_load_error()}</div>
							{/snippet}
						</svelte:boundary>
					{/each}
				</div>
			{/if}
		</div>

		<div class="shrink-0 border-t border-border p-3">
			<button
				type="button"
				onclick={editSnippets}
				class="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-background text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
			>
				<Settings2 class="size-4" />
				{m.snippets_edit_all()}
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
