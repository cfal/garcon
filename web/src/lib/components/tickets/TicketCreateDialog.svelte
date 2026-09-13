<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import type { TicketChatSummary } from './ticket-presentation.js';
	import { canSubmitTicketForm, submitTicketForm } from '$lib/tickets/commands/ticket-form.js';
	import TicketFieldsEditor from './TicketFieldsEditor.svelte';
	import TicketDraftFeedback from './TicketDraftFeedback.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		chats,
		username,
		ownerId,
		onClose,
		pinnedProjectPaths = [],
	}: {
		controller: TicketsController;
		chats: readonly TicketChatSummary[];
		username: string;
		ownerId: string;
		onClose: () => void;
		pinnedProjectPaths?: string[];
	} = $props();
	const draft = $derived(controller.createDraft);
	let content = $state<HTMLElement | null>(null);
	let closeRequested = $state(false);
	let composing = $state(false);
	let refining = $state(false);
	const canSubmit = $derived(
		draft !== null && canSubmitTicketForm(draft) && !composing && !refining,
	);
	function requestClose() {
		if (draft?.pending) return;
		if (draft?.canEdit && !draft.field('title').trim() && !draft.field('description').trim())
			draft.discard();
		if (draft?.needsExitGuard) closeRequested = true;
		else {
			closeRequested = false;
			controller.closeCreate();
		}
	}
	async function submit() {
		if (!draft || !canSubmit) return;
		await submitTicketForm(draft);
	}
</script>

<Dialog.Root open={draft !== null} {requestClose}>
	<Dialog.Content
		bind:ref={content}
		class="ticket-dialog sm:max-w-2xl"
		showCloseButton={false}
		data-ticket-dialog-owner={ownerId}
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			closeRequested = false;
			content?.querySelector<HTMLInputElement>('.ticket-title-input')?.focus();
		}}
		onCloseAutoFocus={(event) => {
			event.preventDefault();
			onClose();
		}}
	>
		<Dialog.Header
			><Dialog.Title>{m.tickets_new()}</Dialog.Title><Dialog.Description
				>{m.tickets_recovery_hint()}</Dialog.Description
			></Dialog.Header
		>
		{#if draft}
			<form
				class="ticket-editor"
				onsubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
				oncompositionstart={() => (composing = true)}
				oncompositionend={() => (composing = false)}
			>
				<TicketFieldsEditor
					{controller}
					{draft}
					{chats}
					{username}
					{pinnedProjectPaths}
					onSubmit={() => void submit()}
					onRefinementPendingChange={(pending) => (refining = pending)}
				/>
				{#if !draft.field('project') && controller.projectDefaultError}<p class="ticket-muted">
						{controller.projectDefaultError}
					</p>{/if}
				<TicketDraftFeedback {draft} />
				{#if closeRequested}<div class="ticket-notice">
						<p>{m.tickets_discard_confirm()}</p>
						<div class="ticket-actions">
							<button
								type="button"
								class="ticket-button"
								onclick={() => {
									closeRequested = false;
									controller.closeCreate();
								}}>{m.tickets_keep_draft()}</button
							>
							<button
								type="button"
								class="ticket-button"
								onclick={() => {
									draft.discard();
									closeRequested = false;
									controller.closeCreate();
								}}>{m.tickets_discard()}</button
							>
							<button type="button" class="ticket-button" onclick={() => (closeRequested = false)}
								>{m.tickets_keep()}</button
							>
						</div>
					</div>{/if}
				<Dialog.Footer>
					<button type="button" class="ticket-button" disabled={draft.pending} onclick={requestClose}
						>{m.tickets_cancel()}</button
					>
					<button type="submit" class="ticket-button ticket-primary" disabled={!canSubmit}
						>{draft.pending ? m.tickets_creating() : m.tickets_create()}</button
					>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
