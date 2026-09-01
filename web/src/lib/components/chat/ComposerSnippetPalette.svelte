<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import Search from '@lucide/svelte/icons/search';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import * as Dialog from '$lib/components/ui/dialog';
	import { getAppShell, getLocalSettings, getSnippets } from '$lib/context';
	import type { SnippetInsertionHandler } from '$lib/chat/composer/snippet-insertion.js';
	import { normalizeSnippetTrigger } from '$lib/chat/composer/snippet-trigger.js';
	import { snippetPreview } from '$lib/snippets/snippet-presentation.js';
	import * as m from '$lib/paraglide/messages.js';
	import {
		SNIPPET_ARGUMENTS_TOKEN,
		SNIPPET_CHAT_ID_TOKEN,
		SNIPPET_PROJECT_PATH_TOKEN,
		snippetTemplateUsesArguments,
		snippetTemplateUsesChatId,
		snippetTemplateUsesProjectPath,
	} from '$shared/snippets';
	import ComposerSnippetArgumentsDialog from './ComposerSnippetArgumentsDialog.svelte';
	import { ComposerSnippetPaletteState } from './composer-snippet-palette-state.svelte.js';
	import { flushSync } from 'svelte';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		initialQuery?: string;
		interactionKey: string;
		contextHint?: string | null;
		onInsert: SnippetInsertionHandler;
		onCancelled?: () => void;
		onReturnFocus: () => void;
		onEditSnippets: () => void;
	}

	let {
		open,
		onOpenChange,
		initialQuery = '',
		interactionKey,
		contextHint = null,
		onInsert,
		onCancelled,
		onReturnFocus,
		onEditSnippets,
	}: Props = $props();

	const snippets = getSnippets();
	const appShell = getAppShell();
	const localSettings = getLocalSettings();
	const uid = $props.id();
	const listId = `${uid}-list`;
	const searchId = `${uid}-search`;
	const palette = new ComposerSnippetPaletteState(uid, {
		get snippets() {
			return snippets.snippets;
		},
		get interactionKey() {
			return interactionKey;
		},
		get contextAvailable() {
			return contextHint === null;
		},
		onOpenChange: (nextOpen) => onOpenChange(nextOpen),
		onInsert: (snippet, argumentsText) => onInsert(snippet, argumentsText),
		onCancelled: () => onCancelled?.(),
		onReturnFocus: () => onReturnFocus(),
		onEditSnippets: () => onEditSnippets(),
	});
	const triggerHint = $derived(normalizeSnippetTrigger(localSettings.snippetTrigger));
	const mobileKeyboardVisible = $derived(appShell.isMobile && appShell.keyboardHeight > 0);

	$effect(() => {
		palette.syncOpen(open, initialQuery);
	});

	$effect(() => {
		if (open) void snippets.ensureLoaded().catch(() => undefined);
	});

	$effect(() => {
		palette.syncInteractionKey(interactionKey, open);
	});

	function retryLoad(): void {
		void snippets.refresh({ initial: true }).catch(() => undefined);
	}

	function handleOpenChange(nextOpen: boolean): void {
		if (nextOpen) onOpenChange(true);
		else flushSync(() => onOpenChange(false));
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="top-[var(--app-viewport-center-y)] flex h-[min(42rem,calc(var(--app-height)-1rem))] w-[calc(100vw-1rem)] max-w-lg flex-col gap-0 overflow-hidden p-0"
		showCloseButton={true}
		onCloseAutoFocus={(event) => palette.handlePaletteCloseAutoFocus(event)}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 pr-12">
			<Dialog.Title>{m.snippets_picker_title()}</Dialog.Title>
			<Dialog.Description>{m.snippets_picker_description()}</Dialog.Description>
		</Dialog.Header>

		<div class="shrink-0 border-b border-border px-4 py-3">
			<label class="sr-only" for={searchId}>{m.snippets_search_label()}</label>
			<div class="relative">
				<Search
					class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<input
					id={searchId}
					bind:value={palette.query}
					type="search"
					role="combobox"
					aria-expanded="true"
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={palette.highlightedSnippet
						? palette.optionIdFor(palette.highlightedSnippet.id)
						: undefined}
					oninput={() => palette.resetHighlight()}
					onkeydown={(event) => palette.handleSearchKeyDown(event)}
					placeholder={m.snippets_search_placeholder()}
					class="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
				/>
			</div>
		</div>

		<div id={listId} role="listbox" class="min-h-0 flex-1 overflow-y-auto p-2">
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
			{:else if palette.filteredSnippets.length === 0}
				<p class="px-3 py-8 text-center text-sm text-muted-foreground">
					{palette.query.trim() ? m.snippets_search_empty() : m.snippets_empty()}
				</p>
			{:else}
				<div class="space-y-1">
					{#each palette.filteredSnippets as snippet (snippet.id)}
						<svelte:boundary>
							<div
								id={palette.optionIdFor(snippet.id)}
								role="option"
								aria-selected={snippet.id === palette.highlightedSnippet?.id}
								aria-disabled={!palette.contextAvailable}
								onclick={() => palette.selectSnippet(snippet)}
								onmouseenter={() => palette.highlight(snippet.id)}
								class="flex min-h-14 w-full items-start gap-3 rounded-md px-3 py-2 {snippet.id ===
								palette.highlightedSnippet?.id
									? 'bg-muted'
									: ''} {palette.contextAvailable ? 'cursor-pointer' : 'cursor-not-allowed'}"
							>
								<FileText class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								<span class="min-w-0 flex-1">
									<span class="flex flex-wrap items-center gap-2">
										<span class="truncate text-sm font-medium">{snippet.shortName}</span>
										{#if snippetTemplateUsesArguments(snippet.template)}
											<span
												class="shrink-0 rounded border border-border bg-background px-1 font-mono text-[10px] text-muted-foreground"
												aria-label={m.snippets_token_arguments_label({
													token: SNIPPET_ARGUMENTS_TOKEN,
												})}
											>
												{SNIPPET_ARGUMENTS_TOKEN}
											</span>
										{/if}
										{#if snippetTemplateUsesProjectPath(snippet.template)}
											<span
												class="shrink-0 rounded border border-border bg-background px-1 font-mono text-[10px] text-muted-foreground"
												aria-label={m.snippets_token_project_path_label({
													token: SNIPPET_PROJECT_PATH_TOKEN,
												})}
											>
												{SNIPPET_PROJECT_PATH_TOKEN}
											</span>
										{/if}
										{#if snippetTemplateUsesChatId(snippet.template)}
											<span
												class="shrink-0 rounded border border-border bg-background px-1 font-mono text-[10px] text-muted-foreground"
												aria-label={m.snippets_token_chat_id_label({
													token: SNIPPET_CHAT_ID_TOKEN,
												})}
											>
												{SNIPPET_CHAT_ID_TOKEN}
											</span>
										{/if}
									</span>
									<span class="block truncate text-xs text-muted-foreground">
										{snippetPreview(snippet)}
									</span>
								</span>
							</div>
							{#snippet failed()}
								<div class="px-3 py-2 text-sm text-destructive">{m.snippets_load_error()}</div>
							{/snippet}
						</svelte:boundary>
					{/each}
				</div>
			{/if}
		</div>

		{#if palette.highlightedSnippet && !mobileKeyboardVisible}
			<div class="snippet-template-preview-shell shrink-0 border-t border-border px-4 py-3">
				<!-- The overflow preview is keyboard-scrollable and exposes the complete template. Follow-up: INLINE_SNIPPET_EXPANSION.md#a11y-suppression-register. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<pre
					role="region"
					tabindex="0"
					aria-label={m.snippets_template_preview_label()}
					class="h-28 overflow-y-auto font-mono text-xs leading-4 whitespace-pre-wrap text-muted-foreground sm:h-40">{palette
						.highlightedSnippet.template}</pre>
			</div>
		{/if}

		{#if contextHint}
			<p class="shrink-0 border-t border-border px-5 py-2 text-xs text-muted-foreground">
				{contextHint}
			</p>
		{/if}

		<div class="shrink-0 space-y-2 border-t border-border p-3">
			<button
				type="button"
				onclick={() => palette.editSnippets()}
				class="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-background text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
			>
				<Settings2 class="size-4" />
				{m.snippets_edit_all()}
			</button>
			<p class="text-center text-xs text-muted-foreground">
				{m.snippets_palette_trigger_hint({ trigger: triggerHint })}
			</p>
		</div>
	</Dialog.Content>
</Dialog.Root>

<ComposerSnippetArgumentsDialog
	open={palette.argumentsDialogOpen}
	snippet={palette.argumentsSnippet}
	initialArguments={palette.argumentsDraft}
	onClose={() => palette.closeArguments()}
	onSubmit={(snippet, argumentsText) => palette.submitArguments(snippet, argumentsText)}
	onCancelled={() => palette.settleArgumentsCancel()}
	{onReturnFocus}
/>

<style>
	@media (max-height: 36rem) {
		.snippet-template-preview-shell {
			display: none;
		}
	}
</style>
