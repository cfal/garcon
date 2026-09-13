<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { IssueDraftState } from '$lib/issues/drafts/issue-draft-state.svelte.js';
	import {
		canSubmitIssueForm,
		isIssueSubmitKey,
		submitIssueForm,
	} from '$lib/issues/commands/issue-form.js';
	import IssueTextEditor from './IssueTextEditor.svelte';
	import IssueDraftFeedback from './IssueDraftFeedback.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		draft,
		onCancel,
		onSubmitted,
		visible = true,
	}: {
		draft: IssueDraftState;
		onCancel?: () => void;
		onSubmitted?: (draft: IssueDraftState) => void;
		visible?: boolean;
	} = $props();
	let active = true;
	onDestroy(() => {
		active = false;
	});
	let preview = $state(false);
	let composing = $state(false);
	let refining = $state(false);
	const canSubmit = $derived(canSubmitIssueForm(draft) && !composing && !refining);
	const submitLabel = $derived.by(() => {
		if (draft.pending) return m.issues_saving();
		return draft.current.kind === 'comment-edit' ? m.issues_save() : m.issues_comment();
	});
	async function submit() {
		if (!canSubmit) return;
		const submitted = draft;
		await submitIssueForm(submitted);
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
	class="issue-composer"
	onsubmit={(event) => {
		event.preventDefault();
		void submit();
	}}
	oncompositionstart={() => (composing = true)}
	oncompositionend={() => (composing = false)}
>
	<IssueTextEditor
		{draft}
		kind="comment"
		bind:preview
		active={visible}
		onPendingChange={(pending) => (refining = pending)}
		onkeydown={(event) => {
			if (isIssueSubmitKey(event)) {
				event.preventDefault();
				void submit();
			}
		}}
	/>
	<IssueDraftFeedback {draft} />
	<div class="issue-actions issue-composer-footer">
		<span class="issue-muted">{m.issues_comment_hint()}</span>
		{#if onCancel}<button
				type="button"
				class="issue-button"
				disabled={draft.pending}
				onclick={onCancel}>{m.issues_cancel()}</button
			>{/if}
		<button class="issue-button issue-primary" type="submit" disabled={!canSubmit}
			>{submitLabel}</button
		>
	</div>
</form>
