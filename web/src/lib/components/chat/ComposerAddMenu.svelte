<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator,
		DropdownMenuSub,
		DropdownMenuSubContent,
		DropdownMenuSubTrigger,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { getAppShell, getSnippets } from '$lib/context';
	import type { SnippetInsertionHandler } from '$lib/chat/composer/snippet-insertion.js';
	import { snippetPreview } from '$lib/snippets/snippet-presentation.js';
	import * as m from '$lib/paraglide/messages.js';
	import { snippetTemplateUsesArguments, type Snippet } from '$shared/snippets';
	import ComposerSnippetArgumentsDialog from './ComposerSnippetArgumentsDialog.svelte';
	import ComposerSnippetPickerDialog from './ComposerSnippetPickerDialog.svelte';

	interface Props {
		disabled?: boolean;
		interactionKey: string;
		canAttachImages: boolean;
		attachImagesTooltip: string;
		onAddImage: () => void;
		onInsertSnippet: SnippetInsertionHandler;
		onEditSnippets: () => void;
		onRequestComposerFocus: () => void;
	}

	let {
		disabled = false,
		interactionKey,
		canAttachImages,
		attachImagesTooltip,
		onAddImage,
		onInsertSnippet,
		onEditSnippets,
		onRequestComposerFocus,
	}: Props = $props();
	const appShell = getAppShell();
	const snippets = getSnippets();
	let open = $state(false);
	let mobilePickerOpen = $state(false);
	let argumentsDialogOpen = $state(false);
	let argumentsSnippet = $state<Snippet | null>(null);
	let argumentsDraft = $state('');
	let activeInteractionKey = $state<string | null>(null);

	$effect(() => {
		const currentInteractionKey = interactionKey;
		if (
			activeInteractionKey === null ||
			activeInteractionKey === currentInteractionKey ||
			(!open && !mobilePickerOpen && !argumentsDialogOpen)
		) {
			return;
		}
		open = false;
		mobilePickerOpen = false;
		argumentsDialogOpen = false;
		argumentsSnippet = null;
		argumentsDraft = '';
		activeInteractionKey = null;
	});

	function handleOpenChange(nextOpen: boolean): void {
		open = nextOpen;
		if (nextOpen) {
			activeInteractionKey = interactionKey;
			void snippets.ensureLoaded().catch(() => undefined);
		}
	}

	function openMobilePicker(): void {
		open = false;
		activeInteractionKey = interactionKey;
		mobilePickerOpen = true;
	}

	function selectSnippet(snippet: Snippet): void {
		open = false;
		const selectedInteractionKey = activeInteractionKey ?? interactionKey;
		if (selectedInteractionKey !== interactionKey) {
			activeInteractionKey = null;
			return;
		}
		activeInteractionKey = selectedInteractionKey;
		if (snippetTemplateUsesArguments(snippet.template)) {
			argumentsSnippet = snippet;
			argumentsDraft = '';
			argumentsDialogOpen = true;
			return;
		}
		activeInteractionKey = null;
		void onInsertSnippet(snippet, '');
	}

	async function submitSnippetWithArguments(
		snippet: Snippet,
		argumentsText: string,
	): Promise<void> {
		const submittedInteractionKey = activeInteractionKey;
		if (submittedInteractionKey === null || submittedInteractionKey !== interactionKey) {
			activeInteractionKey = null;
			argumentsDraft = '';
			return;
		}
		const result = await onInsertSnippet(snippet, argumentsText);
		if (
			result === 'failed' &&
			activeInteractionKey === submittedInteractionKey &&
			submittedInteractionKey === interactionKey
		) {
			activeInteractionKey = submittedInteractionKey;
			argumentsSnippet = snippet;
			argumentsDraft = argumentsText;
			argumentsDialogOpen = true;
			return;
		}
		activeInteractionKey = null;
		argumentsDraft = '';
	}

	function editSnippets(): void {
		open = false;
		activeInteractionKey = null;
		onEditSnippets();
	}

	function retryLoad(): void {
		void snippets.refresh({ initial: true }).catch(() => undefined);
	}
</script>

<DropdownMenu {open} onOpenChange={handleOpenChange}>
	<DropdownMenuTrigger
		{disabled}
		class="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
		title={m.snippets_add_to_prompt()}
		aria-label={m.snippets_add_to_prompt()}
	>
		<Plus class="size-4" />
	</DropdownMenuTrigger>
	<DropdownMenuContent align="start">
		<DropdownMenuItem onclick={onAddImage} disabled={!canAttachImages} class="items-start">
			<ImagePlus class="mt-0.5 size-4" />
			<div class="min-w-0">
				<div class="font-medium">{m.chat_composer_add_image()}</div>
				<div class="text-xs text-muted-foreground">
					{canAttachImages ? m.chat_composer_attach_image_files() : attachImagesTooltip}
				</div>
			</div>
		</DropdownMenuItem>

		{#if appShell.isMobile}
			<DropdownMenuItem onclick={openMobilePicker} class="items-start">
				<FileText class="mt-0.5 size-4" />
				<div class="min-w-0">
					<div class="font-medium">{m.snippets_menu_title()}</div>
					<div class="text-xs text-muted-foreground">{m.snippets_menu_description()}</div>
				</div>
			</DropdownMenuItem>
		{:else}
			<DropdownMenuSub>
				<DropdownMenuSubTrigger class="items-start">
					<FileText class="mt-0.5 size-4" />
					<div class="min-w-0 text-left">
						<div class="font-medium">{m.snippets_menu_title()}</div>
						<div class="text-xs text-muted-foreground">{m.snippets_menu_description()}</div>
					</div>
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent
					class="flex max-h-[min(22rem,var(--bits-menu-content-available-height))] w-[min(22rem,calc(100vw-1rem))] flex-col p-0"
				>
					<div class="min-h-0 flex-1 overflow-y-auto p-1">
						{#if snippets.status === 'loading' && !snippets.hasLoaded}
							<div class="px-3 py-5 text-center text-sm text-muted-foreground">
								{m.snippets_loading()}
							</div>
						{:else if snippets.status === 'error' && !snippets.hasLoaded}
							<div class="space-y-2 px-3 py-4 text-center">
								<p class="text-sm text-destructive">{m.snippets_load_error()}</p>
								<DropdownMenuItem onclick={retryLoad} closeOnSelect={false} class="justify-center">
									<RefreshCw class="size-3.5" />
									{m.snippets_retry()}
								</DropdownMenuItem>
							</div>
						{:else if snippets.snippets.length === 0}
							<div class="px-3 py-5 text-center text-sm text-muted-foreground">
								{m.snippets_empty()}
							</div>
						{:else}
							{#each snippets.snippets as snippet (snippet.id)}
								<svelte:boundary>
									<DropdownMenuItem
										onclick={() => selectSnippet(snippet)}
										class="min-h-12 items-start"
									>
										<FileText class="mt-0.5 size-4" />
										<div class="min-w-0">
											<div class="truncate font-medium">{snippet.shortName}</div>
											<div class="truncate text-xs text-muted-foreground">
												{snippetPreview(snippet)}
											</div>
										</div>
									</DropdownMenuItem>
									{#snippet failed()}
										<div class="px-3 py-2 text-sm text-destructive">{m.snippets_load_error()}</div>
									{/snippet}
								</svelte:boundary>
							{/each}
						{/if}
					</div>
					<DropdownMenuSeparator class="m-0" />
					<DropdownMenuItem onclick={editSnippets} class="m-1">
						<Settings2 class="size-4" />
						{m.snippets_edit_all()}
					</DropdownMenuItem>
				</DropdownMenuSubContent>
			</DropdownMenuSub>
		{/if}
	</DropdownMenuContent>
</DropdownMenu>

<ComposerSnippetPickerDialog
	open={mobilePickerOpen}
	onOpenChange={(nextOpen) => (mobilePickerOpen = nextOpen)}
	onSelect={selectSnippet}
	{onEditSnippets}
	{onRequestComposerFocus}
/>

<ComposerSnippetArgumentsDialog
	open={argumentsDialogOpen}
	snippet={argumentsSnippet}
	initialArguments={argumentsDraft}
	onClose={() => (argumentsDialogOpen = false)}
	onSubmit={(snippet, argumentsText) => void submitSnippetWithArguments(snippet, argumentsText)}
	{onRequestComposerFocus}
/>
