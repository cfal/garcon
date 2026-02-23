<script lang="ts">
	// Modal for reviewing accumulated draft comments, editing them,
	// writing a summary, and sending the finalized review to chat.

	import X from '@lucide/svelte/icons/x';
	import Send from '@lucide/svelte/icons/send';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Pencil from '@lucide/svelte/icons/pencil';
	import type { GitReviewCommentDraft } from '$lib/api/git.js';

	interface Props {
		commentsByFile: Record<string, GitReviewCommentDraft[]>;
		commentCount: number;
		reviewSummary: string;
		isMobile: boolean;
		onSummaryChange: (summary: string) => void;
		onUpdateComment: (id: string, patch: Partial<GitReviewCommentDraft>) => void;
		onRemoveComment: (id: string) => void;
		onSend: () => void;
		onClose: () => void;
	}

	let {
		commentsByFile,
		commentCount,
		reviewSummary,
		isMobile,
		onSummaryChange,
		onUpdateComment,
		onRemoveComment,
		onSend,
		onClose,
	}: Props = $props();

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

	function handleBackdropClick(e: MouseEvent): void {
		if (e.target === e.currentTarget) onClose();
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
	onclick={handleBackdropClick}
	onkeydown={handleKeydown}
>
	<div class="bg-background border border-border rounded-lg shadow-xl flex flex-col
		{isMobile ? 'w-full h-full rounded-none' : 'w-[560px] max-h-[80vh]'}">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
			<h2 class="text-sm font-medium text-foreground">
				Review changes
				{#if commentCount > 0}
					<span class="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-interactive-accent text-interactive-accent-foreground">
						{commentCount}
					</span>
				{/if}
			</h2>
			<button
				onclick={onClose}
				class="p-1 rounded hover:bg-muted transition-colors"
			>
				<X class="w-4 h-4 text-muted-foreground" />
			</button>
		</div>

		<!-- Comments list -->
		<div class="flex-1 overflow-y-auto">
			{#if commentCount === 0}
				<div class="px-4 py-8 text-xs text-muted-foreground text-center">
					No comments yet. Click the comment icon on a diff line to add one.
				</div>
			{:else}
				{#each Object.entries(commentsByFile) as [filePath, fileComments]}
					<div class="border-b border-border/50">
						<div class="px-4 py-2 bg-muted/20">
							<span class="text-[11px] font-mono text-muted-foreground truncate">{filePath}</span>
						</div>
						{#each fileComments as comment}
							<div class="px-4 py-2.5 border-b border-border/30 group">
								<div class="flex items-start gap-2">
									<span class="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded shrink-0 {severityColor(comment.severity)}">
										{comment.severity}
									</span>
									<span class="text-[11px] text-muted-foreground shrink-0">
										L{comment.line}{comment.lineEnd ? `-${comment.lineEnd}` : ''} ({comment.side})
									</span>
									<div class="flex-1"></div>
									<button
										onclick={() => startEdit(comment)}
										class="p-0.5 rounded hover:bg-muted transition-colors {isMobile ? '' : 'opacity-0 group-hover:opacity-100'}"
										title="Edit"
									>
										<Pencil class="w-3.5 h-3.5 text-muted-foreground" />
									</button>
									<button
										onclick={() => onRemoveComment(comment.id)}
										class="p-0.5 rounded hover:bg-muted transition-colors {isMobile ? '' : 'opacity-0 group-hover:opacity-100'}"
										title="Delete"
									>
										<Trash2 class="w-3.5 h-3.5 text-muted-foreground" />
									</button>
								</div>
								{#if editingId === comment.id}
									<textarea
										bind:value={editBody}
										onkeydown={(e) => {
											if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
											if (e.key === 'Escape') cancelEdit();
										}}
										class="mt-1.5 w-full text-xs p-2 bg-muted border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
										rows="2"
									></textarea>
									<div class="flex gap-1.5 mt-1.5">
										<button onclick={commitEdit} class="px-2.5 py-1 text-[10px] rounded bg-interactive-accent text-interactive-accent-foreground">Save</button>
										<button onclick={cancelEdit} class="px-2.5 py-1 text-[10px] rounded bg-muted text-muted-foreground">Cancel</button>
									</div>
								{:else}
									<p class="mt-1.5 text-xs text-foreground">{comment.body}</p>
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			{/if}
		</div>

		<!-- Summary and send -->
		<div class="border-t border-border px-4 py-3 space-y-2.5 shrink-0">
			<textarea
				value={reviewSummary}
				oninput={(e) => onSummaryChange(e.currentTarget.value)}
				placeholder="Review summary (optional)..."
				class="w-full text-xs p-2 bg-muted border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				rows="3"
			></textarea>
			<button
				onclick={onSend}
				disabled={commentCount === 0 && !reviewSummary.trim()}
				class="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded
					{commentCount > 0 || reviewSummary.trim()
						? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
						: 'bg-muted text-muted-foreground cursor-not-allowed'} transition-all"
			>
				<Send class="w-3.5 h-3.5" />
				Send review to chat
			</button>
		</div>
	</div>
</div>
