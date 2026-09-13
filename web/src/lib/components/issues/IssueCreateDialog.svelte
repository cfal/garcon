<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import type { IssueChatSummary } from './issue-presentation.js';
	import { canSubmitIssueForm, submitIssueForm } from '$lib/issues/commands/issue-form.js';
	import IssueFieldsEditor from './IssueFieldsEditor.svelte';
	import IssueDraftFeedback from './IssueDraftFeedback.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		chats,
		username,
		ownerId,
		onClose,
		pinnedProjectPaths = [],
	}: {
		controller: IssuesController;
		chats: readonly IssueChatSummary[];
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
		draft !== null && canSubmitIssueForm(draft) && !composing && !refining,
	);
	function requestClose() {
		if (draft?.pending) return;
		if (draft?.needsExitGuard) closeRequested = true;
		else controller.closeCreate();
	}
	async function submit() {
		if (!draft || !canSubmit) return;
		await submitIssueForm(draft);
	}
</script>

<Dialog.Root open={draft !== null} {requestClose}>
	<Dialog.Content
		bind:ref={content}
		class="issue-dialog sm:max-w-2xl"
		showCloseButton={false}
		data-issue-dialog-owner={ownerId}
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			content?.querySelector<HTMLInputElement>('.issue-title-input')?.focus();
		}}
		onCloseAutoFocus={(event) => {
			event.preventDefault();
			onClose();
		}}
	>
		<Dialog.Header
			><Dialog.Title>{m.issues_new()}</Dialog.Title><Dialog.Description
				>{m.issues_recovery_hint()}</Dialog.Description
			></Dialog.Header
		>
		{#if draft}
			<form
				class="issue-editor"
				onsubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
				oncompositionstart={() => (composing = true)}
				oncompositionend={() => (composing = false)}
			>
				<IssueFieldsEditor
					{controller}
					{draft}
					{chats}
					{username}
					{pinnedProjectPaths}
					onSubmit={() => void submit()}
					onRefinementPendingChange={(pending) => (refining = pending)}
				/>
				{#if !draft.field('project')}<p class="issue-muted">
						{controller.projectDefaultError ?? m.issues_project_required()}
					</p>{/if}
				<IssueDraftFeedback {draft} />
				{#if closeRequested}<div class="issue-notice">
						<p>{m.issues_discard_confirm()}</p>
						<div class="issue-actions">
							<button
								type="button"
								class="issue-button"
								onclick={() => {
									closeRequested = false;
									controller.closeCreate();
								}}>{m.issues_keep_draft()}</button
							>
							<button
								type="button"
								class="issue-button"
								onclick={() => {
									draft.discard();
									closeRequested = false;
									controller.closeCreate();
								}}>{m.issues_discard()}</button
							>
							<button type="button" class="issue-button" onclick={() => (closeRequested = false)}
								>{m.issues_keep()}</button
							>
						</div>
					</div>{/if}
				<Dialog.Footer>
					<button type="button" class="issue-button" disabled={draft.pending} onclick={requestClose}
						>{m.issues_cancel()}</button
					>
					<button type="submit" class="issue-button issue-primary" disabled={!canSubmit}
						>{draft.pending ? m.issues_creating() : m.issues_create()}</button
					>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
