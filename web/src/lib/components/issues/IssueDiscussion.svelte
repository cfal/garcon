<script lang="ts">
	import { untrack } from 'svelte';
	import type { IssueCommentView, IssueDetail } from '$shared/issues';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import type { IssueChatSummary } from './issue-presentation.js';
	import IssueActor from './IssueActor.svelte';
	import IssueCommentComposer from './IssueCommentComposer.svelte';
	import IssueMarkdown from './IssueMarkdown.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		detail,
		chats,
		username,
		onOpenChat,
		onSubmitted,
	}: {
		controller: IssuesController;
		detail: IssueDetail;
		chats: readonly IssueChatSummary[];
		username: string;
		onOpenChat: (id: string) => void;
		onSubmitted: () => void;
	} = $props();
	const composer = untrack(() => controller.drafts.open('comment', detail));
	const editing = $derived(controller.detail.commentEditDraft);
	let removing = $state.raw<IssueCommentView | null>(null);
	function edit(comment: IssueCommentView) {
		controller.detail.commentEditDraft = controller.drafts.open(
			'comment-edit',
			detail,
			{ body: comment.body ?? '' },
			comment,
		);
	}
	async function remove() {
		if (!removing) return;
		await controller.mutate(detail.issue, {
			action: 'comment-delete',
			issueId: detail.issue.id,
			commentId: removing.id,
			expectedRevision: removing.revision,
		});
		removing = null;
	}
</script>

{#if detail.comments.nextBeforeSequence !== null}<button
		type="button"
		class="issue-button"
		disabled={!!controller.pagePending}
		onclick={() => void controller.loadOlderComments()}>{m.issues_older_comments()}</button
	>{/if}
{#if controller.detail.newComments}<button type="button" class="issue-button" onclick={onSubmitted}
		>{m.issues_new_comments()}</button
	>{/if}
<div class="issue-comments">
	{#each detail.comments.items as comment (comment.id)}
		<svelte:boundary>
			<article class="issue-comment" data-comment-id={comment.id}>
				<header>
					<IssueActor actor={comment.author} {chats} {username} {onOpenChat} /><time
						datetime={comment.createdAt}
						title={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time
					>{#if comment.revision > 1 && !comment.deletedAt}<span>{m.issues_edited()}</span>{/if}
				</header>
				{#if editing?.current.commentId === comment.id}<IssueCommentComposer
						draft={editing}
						onCancel={() => {
							editing?.flush();
							controller.detail.commentEditDraft = null;
						}}
					/>
				{:else if comment.deletedAt}<p class="issue-muted">{m.issues_removed()}</p>
				{:else}<IssueMarkdown text={comment.body ?? ''} />{/if}
				{#if comment.canEdit && !comment.deletedAt && editing?.current.commentId !== comment.id}<div
						class="issue-actions"
					>
						<button type="button" class="issue-text-button" onclick={() => edit(comment)}
							>{m.issues_edit()}</button
						>
						<button type="button" class="issue-text-button" onclick={() => (removing = comment)}
							>{m.issues_remove()}</button
						>
					</div>{/if}
				{#if removing?.id === comment.id}<div class="issue-notice">
						<p>{m.issues_remove_confirm()} {m.issues_history_warning()}</p>
						<button type="button" class="issue-button" onclick={() => void remove()}
							>{m.issues_remove()}</button
						><button type="button" class="issue-button" onclick={() => (removing = null)}
							>{m.issues_cancel()}</button
						>
					</div>{/if}
			</article>
			{#snippet failed()}<p class="issue-notice">{m.issues_invalid_entry()}</p>{/snippet}
		</svelte:boundary>
	{:else}<p class="issue-muted py-4">{m.issues_no_comments()}</p>{/each}
</div>
{#if composer}<IssueCommentComposer
		draft={composer}
		onSubmitted={(submitted) => {
			if (
				submitted === composer &&
				submitted.isCurrentPartition &&
				controller.detail.selectedId === submitted.current.issueId
			)
				onSubmitted();
		}}
	/>{/if}
