<script lang="ts">
	import type { GitReviewCommentDraft } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';

	const severityOptions: GitReviewCommentDraft['severity'][] = ['note', 'warning', 'blocker'];

	interface GitDiffCommentComposerProps {
		colspan: number;
		body: string;
		severity: GitReviewCommentDraft['severity'];
		onBodyChange?: (body: string) => void;
		onSeverityChange?: (severity: GitReviewCommentDraft['severity']) => void;
		onSubmit?: () => void;
		onClose?: () => void;
	}

	let {
		colspan,
		body,
		severity,
		onBodyChange,
		onSeverityChange,
		onSubmit,
		onClose,
	}: GitDiffCommentComposerProps = $props();

	let composerRowElement = $state<HTMLTableRowElement | null>(null);

	$effect(() => {
		if (!composerRowElement) return;
		composerRowElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		const textarea = composerRowElement.querySelector('textarea');
		textarea?.focus();
	});

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			if (body.trim()) onSubmit?.();
		}
		if (event.key === 'Escape') onClose?.();
	}
</script>

<tr bind:this={composerRowElement}>
	<td {colspan} class="p-0">
		<div class="border border-interactive-accent/50 rounded m-1 bg-background shadow-sm p-3 space-y-2">
			<div class="flex gap-2">
				{#each severityOptions as option (option)}
					<label class="flex items-center gap-1 text-[11px] cursor-pointer">
						<input
							type="radio"
							checked={severity === option}
							onchange={() => onSeverityChange?.(option)}
							class="accent-interactive-accent"
						/>
						{option}
					</label>
				{/each}
			</div>
			<textarea
				value={body}
				oninput={(event) => onBodyChange?.(event.currentTarget.value)}
				onkeydown={handleKeydown}
				placeholder={m.git_comment_placeholder()}
				class="w-full text-xs p-2 bg-background border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				rows="3"
			></textarea>
			<div class="flex gap-1.5 justify-end">
				<button
					type="button"
					onclick={() => onClose?.()}
					class="px-2.5 py-1 text-[11px] rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
					>{m.git_confirm_cancel()}</button
				>
				<button
					type="button"
					onclick={() => onSubmit?.()}
					disabled={!body.trim()}
					class="px-2.5 py-1 text-[11px] rounded transition-all {body.trim()
						? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
						: 'bg-muted text-muted-foreground cursor-not-allowed'}"
					>Add comment</button
				>
			</div>
		</div>
	</td>
</tr>
