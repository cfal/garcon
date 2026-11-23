<script lang="ts">
	import { contentSizedTextarea } from '$lib/components/ui/textarea/content-sized-textarea.svelte.js';
	import * as Dialog from '$lib/components/ui/dialog';
	import type {
		CommentComposerState,
		GitDiffSeverity,
	} from '$lib/git/review/git-inline-comment.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import { gitCommentSeverityLabel } from './git-comment-labels';
	import GitCommentAppendError from './GitCommentAppendError.svelte';

	interface Props {
		composer: CommentComposerState;
		onBodyChange: (body: string) => void;
		onSeverityChange: (severity: GitDiffSeverity) => void;
		onSubmit: () => void;
		onClose: () => void;
		onFocusHandled: () => void;
		error?: string | null;
		copyText?: string | null;
	}

	let {
		composer,
		onBodyChange,
		onSeverityChange,
		onSubmit,
		onClose,
		onFocusHandled,
		error = null,
		copyText = null,
	}: Props = $props();
	let textareaElement = $state<HTMLTextAreaElement | null>(null);
	const canSubmit = $derived(composer.body.trim().length > 0);

	$effect(() => {
		if (!textareaElement || !composer.focusPending) return;
		textareaElement.focus();
		onFocusHandled();
	});

	const contentSizing = contentSizedTextarea(() => composer.body);
</script>

<Dialog.Root open={true} requestClose={onClose}>
	<Dialog.Content
		class="top-[var(--app-viewport-center-y)] flex h-[var(--app-height)] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 sm:max-w-none"
		onkeydowncapture={(event) => {
			if (event.key === 'Escape' && (event.isComposing || event.keyCode === 229))
				event.stopPropagation();
		}}
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			textareaElement?.focus();
		}}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-4 py-3 text-start">
			<Dialog.Title class="pe-8 text-sm font-medium">{m.git_comment_add_to_chat()}</Dialog.Title>
		</Dialog.Header>

		<div class="flex-1 overflow-y-auto p-4 space-y-3">
			<div class="text-[11px] text-muted-foreground font-mono truncate">
				{composer.filePath}:{composer.line} ({composer.side})
			</div>

			<div class="flex gap-3">
				{#each ['note', 'warning', 'blocker'] as const as severity (severity)}
					<label class="flex items-center gap-1.5 text-xs cursor-pointer">
						<input
							type="radio"
							checked={composer.severity === severity}
							onchange={() => onSeverityChange(severity)}
							class="accent-interactive-accent"
						/>
						{gitCommentSeverityLabel(severity)}
					</label>
				{/each}
			</div>

			<textarea
				{@attach contentSizing}
				bind:this={textareaElement}
				value={composer.body}
				oninput={(e) => onBodyChange(e.currentTarget.value)}
				placeholder={m.git_comment_placeholder()}
				class="content-sized-textarea w-full p-3 text-base sm:pointer-fine:text-sm bg-background border border-border rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				rows="3"></textarea>
			{#if error}<GitCommentAppendError {error} {copyText} />{/if}
		</div>

		<div class="flex gap-2 px-4 py-3 border-t border-border shrink-0">
			<button
				onclick={onClose}
				class="flex-1 px-3 py-2 text-xs rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
			>
				{m.git_confirm_cancel()}
			</button>
			<button
				onclick={onSubmit}
				disabled={!canSubmit}
				class="flex-1 px-3 py-2 text-xs rounded transition-all
				{canSubmit
					? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
					: 'bg-muted text-muted-foreground cursor-not-allowed'}"
			>
				{m.git_comment_add_to_chat()}
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
