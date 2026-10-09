<script lang="ts">
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Square from '@lucide/svelte/icons/square';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import SurfaceErrorState from '$lib/components/workspace/SurfaceErrorState.svelte';
	import type { PromptEditorSelection } from '$lib/prompt-editor/prompt-editor-selection.js';
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		editorLabel: string;
		text: string;
		selection: PromptEditorSelection;
		focusRequestId: number;
		readOnly: boolean;
		surfaceId?: string;
		headerStatus?: Snippet;
		canRefinePrompt: boolean;
		isPromptRefinementPending: boolean;
		onTextChange: (text: string) => void;
		onSelectionChange: (selection: PromptEditorSelection) => void;
		onRefinePrompt: () => void;
		onClose: () => void;
	}

	let {
		title,
		editorLabel,
		text,
		selection,
		focusRequestId,
		readOnly,
		surfaceId,
		headerStatus,
		canRefinePrompt,
		isPromptRefinementPending,
		onTextChange,
		onSelectionChange,
		onRefinePrompt,
		onClose,
	}: Props = $props();
	const editorRenderer = lazyRenderer(() => import('./PromptEditor.svelte'));
	let retryKey = $state(0);
	let dialogElement = $state<HTMLElement | null>(null);
	let promptRefinementActionLabel = $derived(
		isPromptRefinementPending ? m.prompt_refinement_cancel() : m.prompt_refinement_refine(),
	);

	function handleOpenAutoFocus(event: Event): void {
		event.preventDefault();
		dialogElement?.focus({ preventScroll: true });
	}
</script>

<Dialog.Root open={true} requestClose={onClose}>
	<Dialog.Content
		bind:ref={dialogElement}
		showCloseButton={false}
		transientKind="application-dialog"
		onOpenAutoFocus={handleOpenAutoFocus}
		data-workspace-surface-id={surfaceId}
		data-prompt-editor-dialog
		class="flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[min(88dvh,900px)] sm:w-[min(94vw,1100px)] sm:max-w-none sm:rounded-lg sm:border"
	>
		<div class="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-4">
			<Dialog.Title class="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
				{title}
			</Dialog.Title>
			{#if headerStatus}
				{@render headerStatus()}
			{/if}
			<Button
				variant="outline"
				size="sm"
				class={isPromptRefinementPending
					? 'shrink-0 border-accent bg-accent text-accent-foreground hover:bg-accent/80'
					: 'shrink-0'}
				disabled={!isPromptRefinementPending && !canRefinePrompt}
				onclick={onRefinePrompt}
				aria-label={promptRefinementActionLabel}
				title={promptRefinementActionLabel}
			>
				{#if isPromptRefinementPending}
					<Square class="size-3.5" aria-hidden="true" />
					<span class="hidden sm:inline">{m.prompt_refinement_cancel_short()}</span>
				{:else}
					<Sparkles class="size-3.5" aria-hidden="true" />
					<span class="hidden sm:inline">{m.prompt_refinement_refine()}</span>
				{/if}
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onClose}
				aria-label={m.prompt_editor_close()}
				title={m.prompt_editor_close()}
			>
				<X class="size-4" aria-hidden="true" />
			</Button>
		</div>
		<div class="min-h-0 flex-1 bg-background" aria-busy={isPromptRefinementPending}>
			{#key retryKey}
				{#await editorRenderer()}
					<div
						class="grid h-full place-items-center text-muted-foreground"
						aria-busy="true"
						data-prompt-editor-loading
					>
						<Loader2 class="size-5 animate-spin" aria-label={m.prompt_editor_loading()} />
					</div>
				{:then PromptEditor}
					<div class="h-full" aria-busy="false">
						<PromptEditor
							{text}
							{selection}
							{focusRequestId}
							{readOnly}
							ariaLabel={editorLabel}
							{onTextChange}
							{onSelectionChange}
						/>
					</div>
				{:catch}
					<SurfaceErrorState
						message={m.prompt_editor_load_failed()}
						onRetry={() => (retryKey += 1)}
					/>
				{/await}
			{/key}
		</div>
	</Dialog.Content>
</Dialog.Root>
