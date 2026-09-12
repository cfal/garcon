<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import type { IssueDraftState } from '$lib/issues/drafts/issue-draft-state.svelte.js';
	import IssueDraftFeedback from './IssueDraftFeedback.svelte';
	import {
		canSubmitIssueForm,
		isIssueSubmitKey,
		submitIssueForm,
	} from '$lib/issues/commands/issue-form.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		draft,
		ownerId,
		onClose,
	}: {
		draft: IssueDraftState;
		ownerId: string;
		onClose: () => void;
	} = $props();
	let composing = $state(false);
	async function close() {
		if (composing || !canSubmitIssueForm(draft)) return;
		await submitIssueForm(draft);
	}
	function keydown(event: KeyboardEvent) {
		if (isIssueSubmitKey(event)) {
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
	<Dialog.Content class="issue-dialog" showCloseButton={false} data-issue-dialog-owner={ownerId}>
		<Dialog.Header
			><Dialog.Title>{m.issues_confirm_close()}</Dialog.Title><Dialog.Description
				>{draft.current.issueId}</Dialog.Description
			></Dialog.Header
		>
		<form
			class="issue-editor"
			onsubmit={(event) => {
				event.preventDefault();
				void close();
			}}
			oncompositionstart={() => (composing = true)}
			oncompositionend={() => (composing = false)}
		>
			<label class="issue-field"
				>{m.issues_status()}<select
					class="issue-input text-base"
					onkeydown={keydown}
					value={draft.field('resolution') || 'done'}
					onchange={(event) => draft.setField('resolution', event.currentTarget.value)}
					disabled={!draft.canEdit}
					><option value="done">{m.issues_done()}</option><option value="canceled"
						>{m.issues_canceled()}</option
					></select
				></label
			>
			<label class="issue-field"
				>{m.issues_close_comment()}<textarea
					class="issue-input text-base"
					rows="3"
					onkeydown={keydown}
					disabled={!draft.canEdit}
					value={draft.field('body')}
					data-issue-focus={JSON.stringify({
						kind: 'draft',
						draftId: draft.current.id,
						field: 'composer',
					})}
					data-draft-version={draft.current.version}
					oninput={(event) => draft.setField('body', event.currentTarget.value)}></textarea></label
			>
			<IssueDraftFeedback {draft} />
			<Dialog.Footer
				><button type="button" class="issue-button" disabled={draft.pending} onclick={onClose}
					>{m.issues_cancel()}</button
				><button
					class="issue-button issue-primary"
					disabled={!canSubmitIssueForm(draft) || composing}
					>{draft.pending ? m.issues_saving() : m.issues_close()}</button
				></Dialog.Footer
			>
		</form>
	</Dialog.Content>
</Dialog.Root>
