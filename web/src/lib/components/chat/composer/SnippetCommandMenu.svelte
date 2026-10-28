<script lang="ts">
	// Inline snippet picker for a leading `/s` or `/snippet` command. Filters by
	// the short name typed so far; the composer owns insertion and completion.

	import FileText from '@lucide/svelte/icons/file-text';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import { getTransientLayers } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import {
		selectableSnippetPreview,
		type SelectableSnippet,
	} from '$lib/snippets/selectable-snippet.js';
	import { transientLayer } from '$lib/workspace/transient-layer-action';
	import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id';
	import { SNIPPET_ARGUMENTS_TOKEN, snippetTemplateUsesArguments } from '$shared/snippets';
	import type { SnippetCommandMenuState } from './snippet-command-menu-state.svelte.js';

	interface Props {
		menu: SnippetCommandMenuState;
		isVisible: boolean;
		query: string;
		contextHint?: string | null;
		onClose: () => void;
		onEditSnippets: () => void;
	}

	let { menu, isVisible, query, contextHint = null, onClose, onEditSnippets }: Props = $props();

	const transientLayers = getTransientLayers();
	const layerId = allocateTransientLayerId('snippet-command');
	const uid = $props.id();

	let listElement = $state<HTMLUListElement | null>(null);

	$effect(() => {
		if (isVisible) menu.catalog.ensureLoaded();
	});

	// Keeps the keyboard-highlighted option inside the scrolled list viewport.
	$effect(() => {
		const list = listElement;
		const option = list?.children.item(menu.highlightedIndex);
		if (!list || !(option instanceof HTMLElement)) return;
		const bottom = option.offsetTop + option.offsetHeight;
		if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
		else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
	});

	function takesArguments(snippet: SelectableSnippet): boolean {
		return snippet.source === 'snippet' && snippetTemplateUsesArguments(snippet.body);
	}
</script>

{#if isVisible}
	<div
		class="absolute bottom-full left-0 z-50 mb-1 flex w-[min(26rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-md border border-border bg-popover shadow-md"
		use:transientLayer={{
			registry: transientLayers,
			id: layerId,
			kind: 'menu',
			modality: 'nonmodal',
			onEscape: () => {
				onClose();
				return true;
			},
			restoreFocus: () => undefined,
		}}
	>
		<div class="flex items-center justify-between border-b border-border py-1 pl-3 pr-1">
			<span id="{uid}-title" class="text-xs font-medium text-muted-foreground">
				{m.snippets_title()}
			</span>
			<!-- Pressing the button must not blur the composer and close the mobile keyboard. -->
			<button
				type="button"
				onmousedown={(event) => event.preventDefault()}
				onclick={onEditSnippets}
				aria-label={m.snippets_edit_all()}
				title={m.snippets_edit_all()}
				class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			>
				<Settings2 class="size-4" />
			</button>
		</div>

		{#if menu.catalog.loading}
			<p class="px-3 py-3 text-sm text-muted-foreground">{m.snippets_loading()}</p>
		{:else if menu.catalog.failed}
			<div class="flex items-center justify-between gap-3 px-3 py-2">
				<p class="text-sm text-destructive">{m.snippets_catalog_load_error()}</p>
				<button
					type="button"
					onmousedown={(event) => event.preventDefault()}
					onclick={() => menu.catalog.retry()}
					class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				>
					<RefreshCw class="size-3.5" />
					{m.snippets_retry()}
				</button>
			</div>
		{:else if menu.filteredSnippets.length === 0}
			<p class="px-3 py-3 text-sm text-muted-foreground">
				{query ? m.snippets_search_empty() : m.snippets_empty()}
			</p>
		{:else}
			<ul
				bind:this={listElement}
				id={menu.listId}
				role="listbox"
				aria-labelledby="{uid}-title"
				class="relative max-h-64 overflow-y-auto p-1"
			>
				{#each menu.filteredSnippets as snippet, index (snippet.key)}
					{@const preview = selectableSnippetPreview(snippet)}
					<!-- The composer textarea keeps focus and announces options through aria-activedescendant. Covered by __tests__/PromptComposer.test.ts. -->
					<!-- eslint-disable-next-line svelte/no-unused-svelte-ignore -- The ESLint rule misses the compiler warnings reported by svelte-check for this option. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id={menu.optionIdFor(snippet.key)}
						role="option"
						aria-selected={index === menu.highlightedIndex}
						aria-disabled={!menu.contextAvailable}
						onmousedown={(event) => event.preventDefault()}
						onpointermove={(event) => {
							// Only real mouse movement highlights, so a parked pointer cannot
							// steal the keyboard selection as the list appears or filters.
							if (event.pointerType === 'mouse') menu.highlight(snippet.key);
						}}
						onclick={() => menu.select(snippet)}
						class="flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left text-foreground {index ===
						menu.highlightedIndex
							? 'bg-accent text-accent-foreground'
							: 'hover:bg-muted/50'} {menu.contextAvailable ? 'cursor-pointer' : 'cursor-not-allowed'}"
					>
						<svelte:boundary>
							<FileText class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
							<span class="min-w-0 flex-1">
								<span class="flex items-center gap-2">
									<span class="truncate text-sm font-medium">{snippet.shortName}</span>
									{#if takesArguments(snippet)}
										<span
											class="shrink-0 rounded border border-border bg-background px-1 font-mono text-[10px] text-muted-foreground"
											aria-label={m.snippets_token_arguments_label({
												token: SNIPPET_ARGUMENTS_TOKEN,
											})}
										>
											{SNIPPET_ARGUMENTS_TOKEN}
										</span>
									{:else if snippet.source === 'preamble'}
										<span
											class="shrink-0 rounded border border-border bg-background px-1.5 text-[10px] text-muted-foreground"
										>
											{m.snippets_preamble_badge()}
										</span>
									{/if}
								</span>
								{#if preview}
									<span class="block truncate text-xs text-muted-foreground">{preview}</span>
								{/if}
							</span>
							{#snippet failed()}
								<span class="text-sm text-destructive">{m.snippets_load_error()}</span>
							{/snippet}
						</svelte:boundary>
					</li>
				{/each}
			</ul>
		{/if}

		{#if contextHint}
			<p class="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">{contextHint}</p>
		{:else if menu.highlightedSnippet}
			<p
				class="flex gap-3 border-t border-border px-3 py-1.5 text-xs text-muted-foreground pointer-coarse:hidden"
			>
				<span>{m.snippets_command_menu_insert_hint()}</span>
				{#if takesArguments(menu.highlightedSnippet)}
					<span>{m.snippets_command_menu_arguments_hint()}</span>
				{/if}
			</p>
		{/if}
	</div>
{/if}
