<script lang="ts">
	// Directory picker for a project path field. Mobile presents a full-screen
	// sheet that selects only on confirmation; other layouts present a popover
	// under the field that follows the typed path.

	import { onDestroy, tick } from 'svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CornerLeftUp from '@lucide/svelte/icons/corner-left-up';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getTransientLayers } from '$lib/context';
	import { DirectoryBrowserState } from '$lib/project-paths/directory-browser-state.svelte.js';
	import { splitTypedDirectoryPath } from '$lib/project-paths/directory-location.js';
	import { transientLayerAttachment } from '$lib/workspace/transient-layer-action.js';

	interface DirectoryBrowserProps {
		executorContextKey?: string;
		executorId?: string;
		currentPath: string;
		/** Confines browsing to this subtree. */
		basePath: string;
		onSelect: (path: string) => void;
		onClose: () => void;
		/**
		 * Moves keyboard focus from the open popover back to its field. Defaults to
		 * the element that was focused when the browser opened.
		 */
		onReturnFocus?: () => void;
		isMobile: boolean;
	}

	let {
		executorContextKey = '',
		executorId = 'local',
		currentPath,
		basePath,
		onSelect,
		onClose,
		onReturnFocus,
		isMobile,
	}: DirectoryBrowserProps = $props();
	const transientLayers = getTransientLayers();
	const openedFrom =
		typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;

	function returnFocus(): void {
		if (onReturnFocus) onReturnFocus();
		else openedFrom?.focus();
	}
	const creationErrorId = $props.id();

	const browser = new DirectoryBrowserState({
		get executorId() {
			return executorId;
		},
		get executorContextKey() {
			return executorContextKey;
		},
		get currentPath() {
			return currentPath;
		},
		get basePath() {
			return basePath;
		},
		get confirmsSelection() {
			return isMobile;
		},
		onSelect: (path) => onSelect(path),
		onClose: () => onClose(),
	});

	let newDirectoryButton = $state<HTMLButtonElement | null>(null);
	let confirmButton = $state<HTMLButtonElement | null>(null);
	let list = $state<HTMLUListElement | null>(null);

	// A creation still in flight when the browser closes must not select or refocus.
	onDestroy(() => browser.dispose());

	const rowClass = $derived(
		`flex w-full items-center gap-3 text-start transition-colors hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:outline-none active:bg-muted/70 ${
			isMobile ? 'min-h-12 px-4 text-base' : 'px-3 py-2 text-sm'
		}`,
	);
	const rowIconClass = $derived(isMobile ? 'size-5 shrink-0' : 'size-4 shrink-0');

	/** Moves keyboard focus from the field into the popover's list; reports whether a row took it. */
	export function focusFirstRow(): boolean {
		const row = isMobile ? null : list?.querySelector<HTMLElement>('button');
		if (!row) return false;
		row.focus();
		return true;
	}

	// Splits the path so the footer can emphasize the directory that would be selected.
	const selectedPath = $derived.by(() => {
		const { directory, partial } = splitTypedDirectoryPath(browser.directory);
		return { parent: directory === '/' ? '' : directory, leaf: `/${partial}` };
	});
	const directoryName = $derived(browser.breadcrumbs.at(-1)?.label ?? '');

	// Listing requests follow the browsed directory and are cancelled when it changes.
	$effect(() => browser.trackListing());

	// Long trails and paths scroll; their end names the current directory.
	function keepTrailEndVisible(node: HTMLElement): void {
		void browser.directory;
		node.scrollLeft = node.scrollWidth;
	}

	function focusOnMount(node: HTMLElement): void {
		node.focus();
	}

	// Backs out of the innermost step: the creation form, then the browser.
	function dismiss(): void {
		if (browser.creation) void cancelCreation();
		else onClose();
	}

	function handlePopoverKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		dismiss();
	}

	function handleLayerEscape(): boolean {
		dismiss();
		return true;
	}

	// Arrow keys move focus between the rows of the list. Above its first row,
	// the popover hands focus back to its field.
	function handleRowKeydown(event: KeyboardEvent): void {
		const forward = event.key === 'ArrowDown';
		const row = event.currentTarget;
		if ((!forward && event.key !== 'ArrowUp') || !(row instanceof HTMLElement)) return;
		// Steps by sibling, skipping the item that only reports an empty list.
		let item: Element | null = row.closest('li');
		let next: HTMLElement | null = null;
		while (item && !next) {
			item = forward ? item.nextElementSibling : item.previousElementSibling;
			next = item?.querySelector<HTMLElement>('button') ?? null;
		}
		if (!next && (forward || isMobile)) return;
		event.preventDefault();
		if (next) next.focus();
		else returnFocus();
	}

	// The popover hands focus back to its field. The sheet covers the field, so
	// focus moves to the control that continues the task.
	async function focusAfterCreation(sheetControl: () => HTMLElement | null): Promise<void> {
		await tick();
		if (isMobile) sheetControl()?.focus();
		else returnFocus();
	}

	async function cancelCreation(): Promise<void> {
		browser.cancelCreation();
		await focusAfterCreation(() => newDirectoryButton);
	}

	async function submitCreation(): Promise<void> {
		if (await browser.submitCreation()) await focusAfterCreation(() => confirmButton);
	}

	function handleCreationKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || event.isComposing) return;
		// Enter must not submit a form that contains the path field.
		event.preventDefault();
		event.stopPropagation();
		void submitCreation();
	}
</script>

{#snippet breadcrumbTrail()}
	<div
		class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-muted-foreground"
		{@attach keepTrailEndVisible}
	>
		{#each browser.breadcrumbs as crumb, index (crumb.path)}
			{#if index > 0}
				<ChevronRight class="size-3 shrink-0" aria-hidden="true" />
			{/if}
			<button
				type="button"
				onclick={() => browser.navigate(crumb.path)}
				aria-current={index === browser.breadcrumbs.length - 1 ? 'location' : undefined}
				class="shrink-0 rounded whitespace-nowrap hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-[current=location]:font-medium aria-[current=location]:text-foreground {isMobile
					? 'min-h-11 px-1.5 text-sm'
					: 'px-1 py-0.5 text-xs hover:underline'}"
			>
				{crumb.label}
			</button>
		{/each}
	</div>
{/snippet}

{#snippet creationFields()}
	<input
		type="text"
		bind:value={browser.creationName}
		onkeydown={handleCreationKeydown}
		readonly={browser.creation?.submitting}
		aria-label={m.chat_directory_browser_directory_name()}
		aria-invalid={browser.creationError ? true : undefined}
		aria-describedby={browser.creationError ? creationErrorId : undefined}
		placeholder={m.chat_directory_browser_directory_name()}
		autocomplete="off"
		autocapitalize="off"
		autocorrect="off"
		spellcheck={false}
		enterkeyhint="done"
		data-slot="directory-browser-name"
		class="w-full min-w-0 rounded-md border border-border bg-background px-3 text-base text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive {isMobile
			? 'h-12'
			: 'h-9 sm:pointer-fine:text-sm'}"
		{@attach focusOnMount}
	/>
{/snippet}

{#snippet createButton(sizeClass: string)}
	<Button
		class={sizeClass}
		disabled={!browser.canSubmitCreation}
		aria-busy={browser.creation?.submitting}
		onclick={() => void submitCreation()}
	>
		{#if browser.creation?.submitting}
			<Loader2 class="animate-spin" aria-hidden="true" />
		{/if}
		{m.chat_directory_browser_create()}
	</Button>
{/snippet}

{#snippet creationError()}
	{#if browser.creationError}
		<p id={creationErrorId} role="alert" class="text-xs text-destructive">
			{browser.creationError}
		</p>
	{/if}
{/snippet}

{#snippet directoryList()}
	{#if browser.listing.status === 'loading'}
		<div class="flex items-center justify-center py-8" role="status">
			<Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
			<span class="sr-only">{m.common_loading()}</span>
		</div>
	{:else if browser.listing.status === 'error'}
		<div class="flex flex-col items-start gap-3 px-4 py-4" role="alert">
			<p class="flex items-start gap-2 text-sm text-status-error-foreground">
				<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{browser.listing.message}
			</p>
			<Button variant="outline" size={isMobile ? 'lg' : 'sm'} onclick={() => browser.reload()}>
				{m.common_retry()}
			</Button>
		</div>
	{:else}
		<ul bind:this={list} class="m-0 list-none p-0">
			{#if browser.parentPath !== null}
				{@const parentPath = browser.parentPath}
				<li>
					<button
						type="button"
						onclick={() => browser.navigate(parentPath)}
						onkeydown={handleRowKeydown}
						aria-label={m.chat_directory_browser_parent_directory()}
						class="{rowClass} text-muted-foreground"
					>
						<CornerLeftUp class={rowIconClass} aria-hidden="true" />
						..
					</button>
				</li>
			{/if}
			{#each browser.entries as entry (entry.path)}
				<svelte:boundary>
					<li>
						<button
							type="button"
							onclick={() => browser.navigate(entry.path)}
							onkeydown={handleRowKeydown}
							class="{rowClass} text-foreground"
						>
							<Folder class="{rowIconClass} text-primary" aria-hidden="true" />
							<span class="min-w-0 flex-1 truncate">{entry.name}</span>
							{#if isMobile}
								<ChevronRight class="size-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
							{/if}
						</button>
					</li>
					{#snippet failed()}
						<li class="px-4 py-2 text-sm text-muted-foreground">{entry.path}</li>
					{/snippet}
				</svelte:boundary>
			{/each}
			{#if browser.entries.length === 0}
				<li class="px-4 text-center text-sm text-muted-foreground {isMobile ? 'py-8' : 'py-4'}">
					{browser.query
						? m.chat_directory_browser_no_matches({ query: browser.query })
						: m.chat_directory_browser_no_subdirectories()}
				</li>
			{/if}
			{#if browser.suggestedName !== null}
				{@const name = browser.suggestedName}
				<li>
					<button
						type="button"
						onclick={() => browser.startCreation(name)}
						onkeydown={handleRowKeydown}
						class="{rowClass} text-interactive-accent"
					>
						<Plus class={rowIconClass} aria-hidden="true" />
						<span class="min-w-0 flex-1 truncate">
							{m.chat_directory_browser_create_named({ name })}
						</span>
					</button>
				</li>
			{/if}
		</ul>
	{/if}
{/snippet}

{#if isMobile}
	<Dialog.Root open={true} requestClose={dismiss}>
		<Dialog.Content
			data-slot="directory-browser"
			showCloseButton={false}
			class="top-[var(--app-viewport-center-y)] flex h-[var(--app-height)] max-h-[var(--app-height)] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"
		>
			<div class="flex shrink-0 items-center justify-between gap-2 border-b border-border pl-4 pr-2">
				<Dialog.Title class="min-w-0 truncate text-base font-semibold">
					{m.chat_directory_browser_select_directory()}
				</Dialog.Title>
				<button
					type="button"
					onclick={onClose}
					class="min-h-12 shrink-0 rounded px-2 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					{m.chat_directory_browser_cancel()}
				</button>
			</div>

			<div class="flex shrink-0 items-center border-b border-border px-2.5">
				{@render breadcrumbTrail()}
			</div>

			<div class="shrink-0 border-b border-border px-3 py-2">
				<div class="flex h-11 items-center gap-2 rounded-lg bg-muted/60 pl-3">
					<Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<input
						type="text"
						bind:value={browser.filter}
						aria-label={m.chat_directory_browser_filter_placeholder()}
						placeholder={m.chat_directory_browser_filter_placeholder()}
						autocomplete="off"
						autocapitalize="off"
						autocorrect="off"
						spellcheck={false}
						enterkeyhint="search"
						class="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground/60"
					/>
					{#if browser.filter}
						<button
							type="button"
							onclick={() => (browser.filter = '')}
							aria-label={m.chat_directory_browser_clear_filter()}
							class="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						>
							<X class="size-4" aria-hidden="true" />
						</button>
					{/if}
				</div>
			</div>

			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{@render directoryList()}
			</div>

			<div
				class="shrink-0 space-y-2 border-t border-border px-3 pt-3 pb-[max(0.75rem,var(--safe-area-inset-bottom,0px))]"
			>
				{#if browser.creation}
					<p class="truncate px-1 text-xs text-muted-foreground">
						{m.chat_directory_browser_new_directory_in({ parent: directoryName })}
					</p>
					{@render creationFields()}
					{@render creationError()}
					<div class="flex gap-2">
						<Button
							variant="outline"
							class="h-12 flex-1 text-sm"
							aria-label={m.chat_directory_browser_cancel_creation()}
							onclick={() => void cancelCreation()}
						>
							{m.common_cancel()}
						</Button>
						{@render createButton('h-12 flex-1 text-sm')}
					</div>
				{:else}
					<p
						class="overflow-x-auto px-1 font-mono text-xs whitespace-nowrap text-muted-foreground [scrollbar-width:none]"
						{@attach keepTrailEndVisible}
					>
						{selectedPath.parent}<span class="text-foreground">{selectedPath.leaf}</span>
					</p>
					<div class="flex gap-2">
						<Button
							bind:ref={newDirectoryButton}
							variant="outline"
							class="h-12 shrink-0 px-3 text-sm"
							disabled={!browser.canCreate}
							onclick={() => browser.startCreation()}
						>
							<FolderPlus aria-hidden="true" />
							{m.chat_directory_browser_new_directory()}
						</Button>
						<Button
							bind:ref={confirmButton}
							class="h-12 min-w-0 flex-1 px-3 text-sm"
							disabled={!browser.canConfirm}
							onclick={() => browser.confirm()}
						>
							<span class="truncate">{m.chat_directory_browser_select_this()}</span>
						</Button>
					</div>
				{/if}
			</div>
		</Dialog.Content>
	</Dialog.Root>
{:else}
	<button
		type="button"
		data-slot="directory-browser-dismiss"
		class="fixed inset-0 z-20 border-0 bg-transparent p-0"
		onclick={onClose}
		aria-label={m.editor_actions_close()}
	></button>
	<div
		data-slot="directory-browser"
		class="absolute top-full left-0 right-0 z-30 mt-1 flex max-h-80 flex-col rounded-lg border border-border bg-card shadow-lg"
		role="dialog"
		tabindex="-1"
		aria-label={m.chat_directory_browser_select_directory()}
		onkeydown={handlePopoverKeydown}
		{@attach transientLayerAttachment({
			registry: transientLayers,
			id: 'directory-browser-popover',
			kind: 'popover',
			modality: 'nonmodal',
			onEscape: handleLayerEscape,
			restoreFocus: () => openedFrom?.focus(),
		})}
	>
		<div class="flex shrink-0 items-center gap-2 border-b border-border py-1 pl-2 pr-1">
			{@render breadcrumbTrail()}
			<button
				type="button"
				disabled={!browser.canCreate}
				onclick={() => browser.startCreation()}
				title={m.chat_directory_browser_new_directory()}
				aria-label={m.chat_directory_browser_new_directory()}
				class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
			>
				<FolderPlus class="size-4" aria-hidden="true" />
			</button>
		</div>

		{#if browser.creation}
			<div class="shrink-0 space-y-1.5 border-b border-border p-2">
				<div class="flex items-center gap-2">
					{@render creationFields()}
					{@render createButton('h-9 px-3')}
					<Button
						variant="ghost"
						size="icon"
						class="shrink-0"
						aria-label={m.chat_directory_browser_cancel_creation()}
						title={m.chat_directory_browser_cancel_creation()}
						onclick={() => void cancelCreation()}
					>
						<X aria-hidden="true" />
					</Button>
				</div>
				{@render creationError()}
			</div>
		{/if}

		<div class="min-h-0 flex-1 overflow-y-auto">
			{@render directoryList()}
		</div>
	</div>
{/if}
