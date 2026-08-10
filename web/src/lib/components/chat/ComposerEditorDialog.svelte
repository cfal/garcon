<script lang="ts">
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import SurfaceErrorState from '$lib/components/workspace/SurfaceErrorState.svelte';
	import type { ComposerEditorSelection } from '$lib/chat/composer/composer-editor-selection.js';
	import { CHAT_SURFACE_ID } from '$lib/workspace/surface-types.js';
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		text: string;
		selection: ComposerEditorSelection;
		attachmentCount: number;
		focusRequestId: number;
		onTextChange: (text: string) => void;
		onSelectionChange: (selection: ComposerEditorSelection) => void;
		onClose: () => void;
	}

	let {
		text,
		selection,
		attachmentCount,
		focusRequestId,
		onTextChange,
		onSelectionChange,
		onClose,
	}: Props = $props();
	const editorRenderer = lazyRenderer(() => import('./ComposerEditor.svelte'));
	let retryKey = $state(0);
</script>

<Dialog.Root open={true} requestClose={onClose}>
	<Dialog.Content
		showCloseButton={false}
		transientKind="application-dialog"
		data-workspace-surface-id={CHAT_SURFACE_ID}
		data-composer-editor-dialog
		class="flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[min(88dvh,900px)] sm:w-[min(94vw,1100px)] sm:max-w-none sm:rounded-lg sm:border"
	>
		<div class="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-4">
			<Dialog.Title class="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
				{m.chat_composer_expanded_editor_title()}
			</Dialog.Title>
			{#if attachmentCount > 0}
				<div
					class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
					title={m.chat_composer_expanded_attachment_count({ count: attachmentCount })}
				>
					<span class="sr-only">
						{m.chat_composer_expanded_attachment_count({ count: attachmentCount })}
					</span>
					<Paperclip class="size-3.5" aria-hidden="true" />
					<span aria-hidden="true">{attachmentCount}</span>
				</div>
			{/if}
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={onClose}
				aria-label={m.chat_composer_close_expanded_editor()}
				title={m.chat_composer_close_expanded_editor()}
			>
				<X class="size-4" aria-hidden="true" />
			</Button>
		</div>
		<div class="min-h-0 flex-1 bg-background">
			{#key retryKey}
				{#await editorRenderer()}
					<div
						class="grid h-full place-items-center text-muted-foreground"
						aria-busy="true"
						data-composer-editor-loading
					>
						<Loader2 class="size-5 animate-spin" aria-label={m.chat_composer_editor_loading()} />
					</div>
				{:then ComposerEditor}
					<div class="h-full" aria-busy="false">
						<ComposerEditor
							{text}
							{selection}
							{focusRequestId}
							ariaLabel={m.chat_composer_expanded_editor_label()}
							{onTextChange}
							{onSelectionChange}
						/>
					</div>
				{:catch}
					<SurfaceErrorState
						message={m.chat_composer_editor_load_failed()}
						onRetry={() => (retryKey += 1)}
					/>
				{/await}
			{/key}
		</div>
	</Dialog.Content>
</Dialog.Root>
