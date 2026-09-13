<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { TicketDraftState } from '$lib/tickets/drafts/ticket-draft-state.svelte.js';
	import {
		canSubmitTicketForm,
		isTicketSubmitKey,
		submitTicketForm,
	} from '$lib/tickets/commands/ticket-form.js';
	import TicketTextEditor from './TicketTextEditor.svelte';
	import TicketDraftFeedback from './TicketDraftFeedback.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		draft,
		onCancel,
		onSubmitted,
		visible = true,
	}: {
		draft: TicketDraftState;
		onCancel?: () => void;
		onSubmitted?: (draft: TicketDraftState) => void;
		visible?: boolean;
	} = $props();
	let active = true;
	onDestroy(() => {
		active = false;
	});
	let preview = $state(false);
	let composing = $state(false);
	let refining = $state(false);
	const canSubmit = $derived(canSubmitTicketForm(draft) && !composing && !refining);
	const submitLabel = $derived.by(() => {
		if (draft.pending) return m.tickets_saving();
		return draft.current.kind === 'comment-edit' ? m.tickets_save() : m.tickets_comment();
	});
	async function submit() {
		if (!canSubmit) return;
		const submitted = draft;
		await submitTicketForm(submitted);
		if (
			active &&
			draft === submitted &&
			submitted.isCurrentPartition &&
			!submitted.dirty &&
			!submitted.error
		) {
			preview = false;
			onSubmitted?.(submitted);
		}
	}
</script>

<form
	class="ticket-composer"
	onsubmit={(event) => {
		event.preventDefault();
		void submit();
	}}
	oncompositionstart={() => (composing = true)}
	oncompositionend={() => (composing = false)}
>
	<TicketTextEditor
		{draft}
		kind="comment"
		bind:preview
		active={visible}
		onPendingChange={(pending) => (refining = pending)}
		onkeydown={(event) => {
			if (isTicketSubmitKey(event)) {
				event.preventDefault();
				void submit();
			}
		}}
	/>
	<TicketDraftFeedback {draft} />
	<div class="ticket-actions ticket-composer-footer">
		<span class="ticket-muted">{m.tickets_comment_hint()}</span>
		{#if onCancel}<button
				type="button"
				class="ticket-button"
				disabled={draft.pending}
				onclick={onCancel}>{m.tickets_cancel()}</button
			>{/if}
		<button class="ticket-button ticket-primary" type="submit" disabled={!canSubmit}
			>{submitLabel}</button
		>
	</div>
</form>
