<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import type { TicketDraftState } from '$lib/tickets/drafts/ticket-draft-state.svelte.js';
	import TicketDraftFeedback from './TicketDraftFeedback.svelte';
	import {
		canSubmitTicketForm,
		isTicketSubmitKey,
		submitTicketForm,
	} from '$lib/tickets/commands/ticket-form.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		draft,
		ownerId,
		onClose,
	}: {
		draft: TicketDraftState;
		ownerId: string;
		onClose: () => void;
	} = $props();
	let composing = $state(false);
	async function close() {
		if (composing || !canSubmitTicketForm(draft)) return;
		await submitTicketForm(draft);
	}
	function keydown(event: KeyboardEvent) {
		if (isTicketSubmitKey(event)) {
			event.preventDefault();
			void close();
		}
	}
</script>

<Dialog.Root
	open
	requestClose={() => {
		if (!draft.pending) {
			draft.flush();
			onClose();
		}
	}}
>
	<Dialog.Content class="ticket-dialog" showCloseButton={false} data-ticket-dialog-owner={ownerId}>
		<Dialog.Header
			><Dialog.Title>{m.tickets_confirm_close()}</Dialog.Title><Dialog.Description
				>{draft.current.ticketId}</Dialog.Description
			></Dialog.Header
		>
		<form
			class="ticket-editor"
			onsubmit={(event) => {
				event.preventDefault();
				void close();
			}}
			oncompositionstart={() => (composing = true)}
			oncompositionend={() => (composing = false)}
		>
			<label class="ticket-field"
				>{m.tickets_status()}<select
					class="ticket-input text-base"
					onkeydown={keydown}
					value={draft.field('resolution') || 'done'}
					onchange={(event) => draft.setField('resolution', event.currentTarget.value)}
					disabled={!draft.canEdit}
					><option value="done">{m.tickets_done()}</option><option value="canceled"
						>{m.tickets_canceled()}</option
					></select
				></label
			>
			<label class="ticket-field"
				>{m.tickets_close_comment()}<textarea
					class="ticket-input text-base"
					rows="3"
					onkeydown={keydown}
					disabled={!draft.canEdit}
					value={draft.field('body')}
					data-ticket-focus={JSON.stringify({
						kind: 'draft',
						draftId: draft.current.id,
						field: 'composer',
					})}
					data-draft-version={draft.current.version}
					oninput={(event) => draft.setField('body', event.currentTarget.value)}></textarea></label
			>
			<TicketDraftFeedback {draft} />
			<Dialog.Footer
				><button type="button" class="ticket-button" disabled={draft.pending} onclick={onClose}
					>{m.tickets_cancel()}</button
				><button
					class="ticket-button ticket-primary"
					disabled={!canSubmitTicketForm(draft) || composing}
					>{draft.pending ? m.tickets_saving() : m.tickets_close()}</button
				></Dialog.Footer
			>
		</form>
	</Dialog.Content>
</Dialog.Root>
