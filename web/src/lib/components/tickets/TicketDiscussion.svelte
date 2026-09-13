<script lang="ts">
	import { untrack } from 'svelte';
	import type { TicketCommentView, TicketDetail } from '$shared/tickets';
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import type { TicketChatSummary } from './ticket-presentation.js';
	import TicketActor from './TicketActor.svelte';
	import TicketCommentComposer from './TicketCommentComposer.svelte';
	import TicketMarkdown from './TicketMarkdown.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		detail,
		chats,
		username,
		onOpenChat,
		onSubmitted,
		visible,
	}: {
		controller: TicketsController;
		detail: TicketDetail;
		chats: readonly TicketChatSummary[];
		username: string;
		onOpenChat: (id: string) => void;
		onSubmitted: () => void;
		visible: boolean;
	} = $props();
	const composer = untrack(() => controller.drafts.open('comment', detail));
	const editing = $derived(controller.detail.commentEditDraft);
	let removing = $state.raw<TicketCommentView | null>(null);
	function edit(comment: TicketCommentView) {
		controller.detail.commentEditDraft = controller.drafts.open(
			'comment-edit',
			detail,
			{ body: comment.body ?? '' },
			comment,
		);
	}
	async function remove() {
		if (!removing) return;
		await controller.mutate(detail.ticket, {
			action: 'comment-delete',
			ticketId: detail.ticket.id,
			commentId: removing.id,
			expectedRevision: removing.revision,
		});
		removing = null;
	}
</script>

{#if detail.comments.nextBeforeSequence !== null}<button
		type="button"
		class="ticket-button"
		disabled={!!controller.pagePending}
		onclick={() => void controller.loadOlderComments()}>{m.tickets_older_comments()}</button
	>{/if}
{#if controller.detail.newComments}<button type="button" class="ticket-button" onclick={onSubmitted}
		>{m.tickets_new_comments()}</button
	>{/if}
<div class="ticket-comments">
	{#each detail.comments.items as comment (comment.id)}
		<svelte:boundary>
			<article class="ticket-comment" data-comment-id={comment.id}>
				<header>
					<TicketActor actor={comment.author} {chats} {username} {onOpenChat} /><time
						datetime={comment.createdAt}
						title={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time
					>{#if comment.revision > 1 && !comment.deletedAt}<span>{m.tickets_edited()}</span>{/if}
				</header>
				{#if editing?.current.commentId === comment.id}<TicketCommentComposer
						{visible}
						draft={editing}
						onCancel={() => {
							editing?.flush();
							controller.detail.commentEditDraft = null;
						}}
					/>
				{:else if comment.deletedAt}<p class="ticket-muted">{m.tickets_removed()}</p>
				{:else}<TicketMarkdown text={comment.body ?? ''} />{/if}
				{#if comment.canEdit && !comment.deletedAt && editing?.current.commentId !== comment.id}<div
						class="ticket-actions"
					>
						<button type="button" class="ticket-text-button" onclick={() => edit(comment)}
							>{m.tickets_edit()}</button
						>
						<button type="button" class="ticket-text-button" onclick={() => (removing = comment)}
							>{m.tickets_remove()}</button
						>
					</div>{/if}
				{#if removing?.id === comment.id}<div class="ticket-notice">
						<p>{m.tickets_remove_confirm()} {m.tickets_history_warning()}</p>
						<button type="button" class="ticket-button" onclick={() => void remove()}
							>{m.tickets_remove()}</button
						><button type="button" class="ticket-button" onclick={() => (removing = null)}
							>{m.tickets_cancel()}</button
						>
					</div>{/if}
			</article>
			{#snippet failed()}<p class="ticket-notice">{m.tickets_invalid_entry()}</p>{/snippet}
		</svelte:boundary>
	{:else}<p class="ticket-muted py-4">{m.tickets_no_comments()}</p>{/each}
</div>
{#if composer}<TicketCommentComposer
		{visible}
		draft={composer}
		onSubmitted={(submitted) => {
			if (
				submitted === composer &&
				submitted.isCurrentPartition &&
				controller.detail.selectedId === submitted.current.ticketId
			)
				onSubmitted();
		}}
	/>{/if}
