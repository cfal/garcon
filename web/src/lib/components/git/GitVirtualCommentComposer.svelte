<script lang="ts">
	import type { GitReviewCommentDraft } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';
	import { gitCommentSeverityLabel } from './git-comment-labels';

	const severityOptions: GitReviewCommentDraft['severity'][] = ['note', 'warning', 'blocker'];

	interface GitVirtualCommentComposerProps {
		body: string;
		severity: GitReviewCommentDraft['severity'];
		focusPending: boolean;
		onBodyChange?: (body: string) => void;
		onSeverityChange?: (severity: GitReviewCommentDraft['severity']) => void;
		onSubmit?: () => void;
		onClose?: () => void;
		onFocusHandled?: () => void;
		submitLabel?: string;
	}

	let {
		body,
		severity,
		focusPending,
		onBodyChange,
		onSeverityChange,
		onSubmit,
		onClose,
		onFocusHandled,
		submitLabel = m.git_comment_add(),
	}: GitVirtualCommentComposerProps = $props();

	let composerElement = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!composerElement || !focusPending) return;
		composerElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		composerElement.querySelector('textarea')?.focus();
		onFocusHandled?.();
	});

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			if (body.trim()) onSubmit?.();
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onClose?.();
		}
	}
</script>

<div
	bind:this={composerElement}
	class="m-1 space-y-2 rounded border border-interactive-accent/50 bg-background p-3 shadow-sm"
	data-git-comment-composer
>
	<div class="flex gap-2">
		{#each severityOptions as option (option)}
			<label class="flex cursor-pointer items-center gap-1 text-[11px]">
				<input
					type="radio"
					checked={severity === option}
					onchange={() => onSeverityChange?.(option)}
					class="accent-interactive-accent"
				/>
				{gitCommentSeverityLabel(option)}
			</label>
		{/each}
	</div>
	<textarea
		value={body}
		oninput={(event) => onBodyChange?.(event.currentTarget.value)}
		onkeydown={handleKeydown}
		placeholder={m.git_comment_placeholder()}
		class="w-full resize-none rounded border border-border bg-background p-2 text-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent sm:pointer-fine:text-xs"
		rows="3"></textarea>
	<div class="flex justify-end gap-1.5">
		<button
			type="button"
			onclick={() => onClose?.()}
			class="rounded bg-muted px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			>{m.git_confirm_cancel()}</button
		>
		<button
			type="button"
			onclick={() => onSubmit?.()}
			disabled={!body.trim()}
			class="rounded px-2.5 py-1 text-[11px] transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent {body.trim()
				? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
				: 'cursor-not-allowed bg-muted text-muted-foreground'}">{submitLabel}</button
		>
	</div>
</div>
