<script lang="ts">
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import type { GitReviewCommentDraft } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';
	import { gitCommentSeverityLabel } from './git-comment-labels';

	interface GitVirtualCommentThreadProps {
		comments: GitReviewCommentDraft[];
		editingCommentId: string | null;
		editBody: string;
		onStartEdit: (comment: GitReviewCommentDraft) => void;
		onCancelEdit: () => void;
		onEditBodyChange: (body: string) => void;
		onSaveEdit: (commentId: string) => void;
		onRemoveComment?: (id: string) => void;
	}

	let {
		comments,
		editingCommentId,
		editBody,
		onStartEdit,
		onCancelEdit,
		onEditBodyChange,
		onSaveEdit,
		onRemoveComment,
	}: GitVirtualCommentThreadProps = $props();

	function severityColor(severity: GitReviewCommentDraft['severity']): string {
		switch (severity) {
			case 'blocker':
				return 'text-status-error-foreground bg-status-error/10';
			case 'warning':
				return 'text-status-warning-muted-foreground bg-status-warning/10';
			default:
				return 'text-status-info-foreground bg-status-info/10';
		}
	}
</script>

{#if comments.length > 0}
	<div class="border-l-2 border-interactive-accent bg-muted/20" data-git-comment-thread>
		{#each comments as comment (comment.id)}
			<div class="px-4 py-2">
				{#if editingCommentId === comment.id}
					<div class="space-y-2">
						<textarea
							value={editBody}
							oninput={(event) => onEditBodyChange(event.currentTarget.value)}
							class="w-full resize-none rounded border border-border bg-background p-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
							rows="2"></textarea>
						<div class="flex justify-end gap-1.5">
							<button
								type="button"
								onclick={onCancelEdit}
								class="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								>{m.git_confirm_cancel()}</button
							>
							<button
								type="button"
								onclick={() => onSaveEdit(comment.id)}
								class="rounded bg-interactive-accent px-2 py-0.5 text-[10px] text-interactive-accent-foreground hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								>{m.editor_actions_save()}</button
							>
						</div>
					</div>
				{:else}
					<div class="group/comment flex items-center gap-2">
						<span
							class="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase {severityColor(
								comment.severity,
							)}">{gitCommentSeverityLabel(comment.severity)}</span
						>
						<span class="flex-1 whitespace-pre-wrap text-xs text-foreground">{comment.body}</span>
						<div class="flex gap-1 opacity-0 transition-opacity group-hover/comment:opacity-100">
							<button
								type="button"
								onclick={() => onStartEdit(comment)}
								class="rounded p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								title={m.git_action_edit()}
								aria-label={m.git_action_edit()}
							>
								<Pencil class="h-3 w-3 text-muted-foreground" />
							</button>
							<button
								type="button"
								onclick={() => onRemoveComment?.(comment.id)}
								class="rounded p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								title={m.git_action_remove()}
								aria-label={m.git_action_remove()}
							>
								<Trash2 class="h-3 w-3 text-muted-foreground" />
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
