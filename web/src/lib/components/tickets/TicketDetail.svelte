<script lang="ts">
	import { tick, untrack } from 'svelte';
	import Copy from '@lucide/svelte/icons/copy';
	import type { TicketDetail, TicketSource, TicketStatus } from '$shared/tickets';
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import {
		canSubmitTicketForm,
		ticketEditorFields,
		submitTicketForm,
	} from '$lib/tickets/commands/ticket-form.js';
	import { copyToClipboard } from '$lib/utils/clipboard.js';
	import {
		ticketDeepLink,
		ticketPriorityLabel,
		isTicketProjectPath,
		type TicketChatSummary,
	} from './ticket-presentation.js';
	import TicketStatusMenu from './TicketStatusMenu.svelte';
	import TicketDetailHeader from './TicketDetailHeader.svelte';
	import TicketFieldsEditor from './TicketFieldsEditor.svelte';
	import TicketDraftFeedback from './TicketDraftFeedback.svelte';
	import TicketMutationErrors from './TicketMutationErrors.svelte';
	import TicketDiscussion from './TicketDiscussion.svelte';
	import TicketActivity from './TicketActivity.svelte';
	import TicketRelationships from './TicketRelationships.svelte';
	import TicketMarkdown from './TicketMarkdown.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		detail,
		error,
		chats,
		username,
		onOpenChat,
		onOpenSource,
		onBack,
		onClose,
		closeDisabled = false,
		visible = true,
		onStatus,
	}: {
		controller: TicketsController;
		detail: TicketDetail;
		error: string | null;
		chats: readonly TicketChatSummary[];
		username: string;
		onOpenChat: (id: string) => void;
		onOpenSource: (source: TicketSource) => void;
		onBack: () => void;
		onClose?: () => void;
		closeDisabled?: boolean;
		visible?: boolean;
		onStatus: (status: TicketStatus) => void;
	} = $props();
	const editing = $derived(controller.detail.fieldsDraft);
	let copied = $state('');
	let cancelRequested = $state(false);
	let composing = $state(false);
	let refining = $state(false);
	let scroll = $state<HTMLElement | null>(null);
	let priorComments: TicketDetail['comments'] | null = null;
	const ticket = $derived(controller.mutations.ticket(detail.ticket));
	const saving = $derived(controller.mutations.busy(ticket.id));
	const ownAssignment = $derived(
		ticket.assignee?.kind === 'user' && ticket.assignee.username === username,
	);
	const assigneeLabel = $derived.by(() => {
		const assignee = ticket.assignee;
		if (!assignee) return m.tickets_unassigned();
		if (assignee.kind === 'user') return assignee.username;
		return chats.find((chat) => chat.id === assignee.chatId)?.title ?? assignee.chatId;
	});
	function edit() {
		controller.detail.fieldsDraft = controller.drafts.open(
			'fields',
			detail,
			ticketEditorFields(ticket),
		);
	}
	function cancel() {
		if (editing?.pending) return;
		if (editing?.needsExitGuard) cancelRequested = true;
		else controller.detail.fieldsDraft = null;
	}
	async function save() {
		if (!editing || composing || refining || !canSubmitTicketForm(editing)) return;
		await submitTicketForm(editing);
	}
	async function copyLink() {
		copied = (await copyToClipboard(ticketDeepLink(ticket.id)))
			? m.tickets_copied()
			: m.tickets_copy_failed();
	}
	async function latestComments() {
		await controller.latestDetail();
		await tick();
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
		controller.detail.newComments = false;
	}
	$effect.pre(() => {
		const comments = detail.comments;
		untrack(() => {
			const element = scroll;
			if (!element || !priorComments || comments === priorComments) {
				priorComments = comments;
				return;
			}
			priorComments = comments;
			const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
			const anchor = [...element.querySelectorAll<HTMLElement>('[data-comment-id]')].find(
				(node) => node.getBoundingClientRect().bottom >= element.getBoundingClientRect().top,
			);
			const offset = anchor?.getBoundingClientRect().top;
			void tick().then(() => {
				if (!element.isConnected) return;
				if (nearBottom) {
					element.scrollTop = element.scrollHeight;
					controller.detail.newComments = false;
				} else if (anchor?.isConnected && offset !== undefined)
					element.scrollTop += anchor.getBoundingClientRect().top - offset;
			});
		});
	});
</script>

<section
	class="ticket-detail"
	aria-label={m.tickets_details()}
	bind:this={scroll}
	data-ticket-scroll={`detail:${ticket.id}`}
>
	<TicketDetailHeader {onBack} {onClose} {closeDisabled} />
	{#if error}<div class="ticket-notice" role="alert">
			<p>{error}</p>
			<button class="ticket-button" onclick={() => void controller.refresh()}
				>{m.tickets_retry()}</button
			>
		</div>{/if}
	<TicketMutationErrors drafts={controller.drafts.active} />
	<div class="ticket-detail-identity">
		<span class="ticket-id">{ticket.id}</span>
		<button
			type="button"
			class="ticket-text-button"
			onclick={() => void copyLink()}
			aria-label={m.tickets_copy_link()}
			title={m.tickets_copy_link()}><Copy size={14} /></button
		>
		{#if copied}<span class="ticket-muted" role="status">{copied}</span>{/if}
	</div>
	{#if editing}
		<form
			class="ticket-editor"
			onsubmit={(event) => {
				event.preventDefault();
				void save();
			}}
			oncompositionstart={() => (composing = true)}
			oncompositionend={() => (composing = false)}
		>
			<TicketFieldsEditor
				{controller}
				draft={editing}
				{chats}
				{username}
				active={visible}
				onSubmit={() => void save()}
				onRefinementPendingChange={(pending) => (refining = pending)}
			/><TicketDraftFeedback draft={editing} />
			<div class="ticket-actions">
				<button type="button" class="ticket-button" disabled={editing.pending} onclick={cancel}
					>{m.tickets_cancel()}</button
				><button
					class="ticket-button ticket-primary"
					disabled={!canSubmitTicketForm(editing) || composing || refining}
					>{editing.pending ? m.tickets_saving() : m.tickets_save()}</button
				>
			</div>
			{#if cancelRequested}<div class="ticket-notice">
					<p>{m.tickets_discard_confirm()}</p>
					<button
						type="button"
						class="ticket-button"
						onclick={() => {
							editing?.discard();
							controller.detail.fieldsDraft = null;
							cancelRequested = false;
						}}>{m.tickets_discard()}</button
					><button type="button" class="ticket-button" onclick={() => (cancelRequested = false)}
						>{m.tickets_keep()}</button
					>
				</div>{/if}
		</form>
	{:else}
		<h1
			class="ticket-detail-title"
			tabindex="-1"
			data-ticket-focus={JSON.stringify({ kind: 'toolbar', control: 'detail' })}
		>
			{ticket.title}
		</h1>
		<div class="ticket-actions">
			<TicketStatusMenu {ticket} {onStatus} disabled={saving} variant="button" />
			<button type="button" class="ticket-button" disabled={saving} onclick={edit}
				>{m.tickets_edit()}</button
			>
			{#if ticket.status !== 'closed'}<button
					type="button"
					class="ticket-button"
					disabled={saving}
					onclick={() => onStatus('closed')}>{m.tickets_close()}</button
				>{/if}
		</div>
		<dl class="ticket-properties-read">
			<dt>{m.tickets_project()}</dt>
			<dd class="ticket-project" data-path={isTicketProjectPath(ticket.project)} title={ticket.project}>
				{ticket.project}
			</dd>
			<dt>{m.tickets_priority()}</dt>
			<dd class="ticket-priority" data-priority={ticket.priority}>
				{ticketPriorityLabel(ticket.priority)}
			</dd>
			<dt>{m.tickets_assignee()}</dt>
			<dd class="ticket-assignee-value">
				<span>{assigneeLabel}</span>
				{#if ownAssignment || (ticket.status !== 'closed' && !ticket.assignee)}
					<button
						type="button"
						class="ticket-assignee-action"
						disabled={saving}
						onclick={() =>
							void controller.mutate(ticket, {
								action: ownAssignment ? 'release' : 'claim',
								ticketId: ticket.id,
								expectedRevision: ticket.revision,
							})}>{ownAssignment ? m.tickets_release() : m.tickets_claim()}</button
					>
				{/if}
			</dd>
			{#if ticket.labels.length}<dt>{m.tickets_labels()}</dt>
				<dd>{ticket.labels.join(' · ')}</dd>{/if}
			{#if ticket.parentId}<dt>{m.tickets_parent()}</dt>
				<dd>
					<button
						type="button"
						class="ticket-text-button"
						onclick={() => controller.select(ticket.parentId)}>{ticket.parentId}</button
					>
				</dd>{/if}
		</dl>
		{#if ticket.description}<TicketMarkdown text={ticket.description} />{:else}<p
				class="ticket-muted py-4"
			>
				{m.tickets_no_description()}
			</p>{/if}
	{/if}
	<TicketRelationships {controller} {detail} />
	<nav class="ticket-detail-tabs" aria-label={m.tickets_details()}>
		<button
			type="button"
			aria-pressed={controller.detail.tab === 'comments'}
			onclick={() => (controller.detail.tab = 'comments')}>{m.tickets_comments()}</button
		>
		<button
			type="button"
			aria-pressed={controller.detail.tab === 'activity'}
			onclick={() => {
				controller.detail.tab = 'activity';
				void controller.loadHistory();
			}}>{m.tickets_activity()}</button
		>
		<button
			type="button"
			class="ticket-text-button"
			onclick={() => {
				void controller.latestDetail();
			}}>{m.tickets_latest()}</button
		>
	</nav>
	{#if controller.detail.tab === 'comments'}<TicketDiscussion
			{visible}
			{controller}
			{detail}
			{chats}
			{username}
			{onOpenChat}
			onSubmitted={() => void latestComments()}
		/>
	{:else}<TicketActivity {controller} {chats} {username} {onOpenChat} {onOpenSource} />{/if}
</section>
