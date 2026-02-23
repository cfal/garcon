<script lang="ts">
	// Review draft panel displays accumulated inline comments grouped by
	// file and provides a finalization action to send to the active chat.

	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Send from '@lucide/svelte/icons/send';
	import Pencil from '@lucide/svelte/icons/pencil';
	import type { GitReviewCommentDraft } from '$lib/api/git.js';

	interface GitReviewDraftPanelProps {
		comments: GitReviewCommentDraft[];
		commentsByFile: Record<string, GitReviewCommentDraft[]>;
		reviewSummary: string;
		hasSelection: boolean;
		onUpdateComment: (id: string, patch: Partial<GitReviewCommentDraft>) => void;
		onRemoveComment: (id: string) => void;
		onSummaryChange: (summary: string) => void;
		onFinalizeReview: () => void;
		onStageSelection: () => void;
		onUnstageSelection: () => void;
		onClearSelection: () => void;
	}

	let {
		comments,
		commentsByFile,
		reviewSummary,
		hasSelection,
		onUpdateComment,
		onRemoveComment,
		onSummaryChange,
		onFinalizeReview,
		onStageSelection,
		onUnstageSelection,
		onClearSelection,
	}: GitReviewDraftPanelProps = $props();

	let editingId = $state<string | null>(null);
	let editBody = $state('');

	function startEdit(comment: GitReviewCommentDraft): void {
		editingId = comment.id;
		editBody = comment.body;
	}

	function commitEdit(): void {
		if (editingId && editBody.trim()) {
			onUpdateComment(editingId, { body: editBody.trim() });
		}
		editingId = null;
		editBody = '';
	}

	function cancelEdit(): void {
		editingId = null;
		editBody = '';
	}

	function severityColor(severity: string): string {
		switch (severity) {
			case 'blocker': return 'text-status-error-foreground bg-status-error/10';
			case 'warning': return 'text-status-warning-foreground bg-status-warning/10';
			default: return 'text-status-info-foreground bg-status-info/10';
		}
	}
</script>

<div class="flex flex-col h-full border-l border-border bg-background">
	<!-- Header -->
	<div class="px-3 py-2 border-b border-border">
		<div class="flex items-center gap-2">
			<MessageSquare class="w-4 h-4 text-muted-foreground" />
			<span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
				Review ({comments.length})
			</span>
		</div>
	</div>

	<!-- Selection actions (visible when lines are selected) -->
	{#if hasSelection}
		<div class="px-3 py-2 border-b border-border bg-muted/30 flex gap-2">
			<button
				onclick={onStageSelection}
				class="flex-1 px-2 py-1 text-xs rounded bg-git-added/20 text-git-added hover:bg-git-added/30 transition-colors"
			>
				Stage selection
			</button>
			<button
				onclick={onUnstageSelection}
				class="flex-1 px-2 py-1 text-xs rounded bg-git-deleted/20 text-git-deleted hover:bg-git-deleted/30 transition-colors"
			>
				Unstage
			</button>
			<button
				onclick={onClearSelection}
				class="px-2 py-1 text-xs rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
			>
				Clear
			</button>
		</div>
	{/if}

	<!-- Comments list -->
	<div class="flex-1 overflow-y-auto">
		{#if comments.length === 0}
			<div class="px-3 py-6 text-xs text-muted-foreground text-center">
				No comments yet. Click the comment icon on a diff line to add one.
			</div>
		{:else}
			{#each Object.entries(commentsByFile) as [filePath, fileComments]}
				<div class="border-b border-border/50">
					<div class="px-3 py-1.5 bg-muted/20">
						<span class="text-[10px] font-mono text-muted-foreground truncate">{filePath}</span>
					</div>
					{#each fileComments as comment}
						<div class="px-3 py-2 border-b border-border/30 group">
							<div class="flex items-start gap-1.5">
								<span class="px-1 py-0.5 text-[9px] font-bold uppercase rounded shrink-0 {severityColor(comment.severity)}">
									{comment.severity}
								</span>
								<span class="text-[10px] text-muted-foreground shrink-0">
									L{comment.line}{comment.lineEnd ? `-${comment.lineEnd}` : ''} ({comment.side})
								</span>
								<div class="flex-1"></div>
								<button
									onclick={() => startEdit(comment)}
									class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted transition-opacity"
									title="Edit"
								>
									<Pencil class="w-3 h-3 text-muted-foreground" />
								</button>
								<button
									onclick={() => onRemoveComment(comment.id)}
									class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted transition-opacity"
									title="Delete"
								>
									<Trash2 class="w-3 h-3 text-muted-foreground" />
								</button>
							</div>
							{#if editingId === comment.id}
								<textarea
									bind:value={editBody}
									onkeydown={(e) => {
										if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
										if (e.key === 'Escape') cancelEdit();
									}}
									class="mt-1 w-full text-xs p-1.5 bg-muted border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
									rows="2"
								></textarea>
								<div class="flex gap-1 mt-1">
									<button onclick={commitEdit} class="px-2 py-0.5 text-[10px] rounded bg-interactive-accent text-interactive-accent-foreground">Save</button>
									<button onclick={cancelEdit} class="px-2 py-0.5 text-[10px] rounded bg-muted text-muted-foreground">Cancel</button>
								</div>
							{:else}
								<p class="mt-1 text-xs text-foreground">{comment.body}</p>
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		{/if}
	</div>

	<!-- Summary and finalize -->
	<div class="border-t border-border px-3 py-2 space-y-2">
		<textarea
			value={reviewSummary}
			oninput={(e) => onSummaryChange(e.currentTarget.value)}
			placeholder="Review summary (optional)..."
			class="w-full text-xs p-2 bg-muted border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			rows="2"
		></textarea>
		<button
			onclick={onFinalizeReview}
			disabled={comments.length === 0 && !reviewSummary.trim()}
			class="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded
				{comments.length > 0 || reviewSummary.trim()
					? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
					: 'bg-muted text-muted-foreground cursor-not-allowed'} transition-all"
		>
			<Send class="w-3.5 h-3.5" />
			Send review to chat
		</button>
	</div>
</div>
