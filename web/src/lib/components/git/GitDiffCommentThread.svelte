<script lang="ts">
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import type { GitReviewCommentDraft } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';
	import { gitCommentSeverityLabel } from './git-comment-labels';

	interface GitDiffCommentThreadProps {
		comments: GitReviewCommentDraft[];
		colspan: number;
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
		colspan,
		editingCommentId,
		editBody,
		onStartEdit,
		onCancelEdit,
		onEditBodyChange,
		onSaveEdit,
		onRemoveComment,
	}: GitDiffCommentThreadProps = $props();

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
	<tr>
		<td {colspan} class="p-0">
			{#each comments as comment (comment.id)}
				<div class="px-4 py-2 bg-muted/20 border-l-2 border-interactive-accent">
					{#if editingCommentId === comment.id}
						<div class="space-y-2">
							<textarea
								value={editBody}
								oninput={(event) => onEditBodyChange(event.currentTarget.value)}
								class="w-full text-xs p-2 bg-background border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								rows="2"
							></textarea>
							<div class="flex gap-1.5 justify-end">
								<button
									type="button"
									onclick={onCancelEdit}
									class="px-2 py-0.5 text-[10px] rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
									>{m.git_confirm_cancel()}</button
								>
								<button
									type="button"
									onclick={() => onSaveEdit(comment.id)}
									class="px-2 py-0.5 text-[10px] rounded bg-interactive-accent text-interactive-accent-foreground hover:brightness-110"
									>{m.editor_actions_save()}</button
								>
							</div>
						</div>
					{:else}
						<div class="flex items-center gap-2 group/comment">
							<span
								class="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded {severityColor(
									comment.severity,
								)}">{gitCommentSeverityLabel(comment.severity)}</span
							>
							<span class="flex-1 text-xs text-foreground whitespace-pre-wrap">{comment.body}</span>
							<div class="flex gap-1 opacity-0 group-hover/comment:opacity-100 transition-opacity">
								<button
									type="button"
									onclick={() => onStartEdit(comment)}
									class="p-0.5 rounded hover:bg-muted"
									title={m.git_action_edit()}
								>
									<Pencil class="w-3 h-3 text-muted-foreground" />
								</button>
								<button
									type="button"
									onclick={() => onRemoveComment?.(comment.id)}
									class="p-0.5 rounded hover:bg-muted"
									title={m.git_action_remove()}
								>
									<Trash2 class="w-3 h-3 text-muted-foreground" />
								</button>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</td>
	</tr>
{/if}
