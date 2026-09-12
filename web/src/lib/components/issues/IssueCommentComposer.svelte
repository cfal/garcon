<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { IssueDraftState } from '$lib/issues/drafts/issue-draft-state.svelte.js';
	import {
		canSubmitIssueForm,
		isIssueSubmitKey,
		submitIssueForm,
	} from '$lib/issues/commands/issue-form.js';
	import IssueMarkdown from './IssueMarkdown.svelte';
	import IssueDraftFeedback from './IssueDraftFeedback.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		draft,
		onCancel,
		onSubmitted,
	}: {
		draft: IssueDraftState;
		onCancel?: () => void;
		onSubmitted?: (draft: IssueDraftState) => void;
	} = $props();
	let active = true;
	onDestroy(() => {
		active = false;
	});
	let preview = $state(false);
	let composing = $state(false);
	const canSubmit = $derived(canSubmitIssueForm(draft) && !composing);
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
	<div class="issue-actions">
		<button
			type="button"
			class="issue-text-button"
			aria-pressed={!preview}
			onclick={() => (preview = false)}>{m.issues_write()}</button
		><button
			type="button"
			class="issue-text-button"
			aria-pressed={preview}
			onclick={() => (preview = true)}>{m.issues_preview()}</button
		>
	</div>
	{#if preview}<IssueMarkdown text={draft.field('body')} />
	{:else}<label class="issue-field"
			><span class="sr-only">{m.issues_comment()}</span>
			<textarea
				class="issue-input"
				rows="4"
				placeholder={m.issues_comment_placeholder()}
				value={draft.field('body')}
				disabled={!draft.canEdit}
				onkeydown={(event) => {
					if (isIssueSubmitKey(event)) {
						event.preventDefault();
						void submit();
					}
				}}
				data-issue-focus={JSON.stringify(
					draft.current.kind === 'comment-edit'
						? {
								kind: 'comment',
								issueId: draft.current.issueId,
								commentId: draft.current.commentId,
								control: 'editor',
							}
						: { kind: 'draft', draftId: draft.current.id, field: 'composer' },
				)}
				data-draft-version={draft.current.version}
				oninput={(event) => draft.setField('body', event.currentTarget.value)}></textarea>
		</label>{/if}
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
			>{draft.pending
				? m.issues_saving()
				: draft.current.kind === 'comment-edit'
					? m.issues_save()
					: m.issues_comment()}</button
		>
	</div>
</form>
