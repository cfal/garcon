<script lang="ts">
	import type { IssueDraftState } from '$lib/issues/drafts/issue-draft-state.svelte.js';
	import { issueEditorFields } from '$lib/issues/commands/issue-form.js';
	import { copyToClipboard } from '$lib/utils/clipboard.js';
	import * as m from '$lib/paraglide/messages.js';
	let { draft }: { draft: IssueDraftState } = $props();
	let discard = $state(false);
	let copyMessage = $state('');
	const current = $derived(draft.conflict?.comment ?? draft.conflict?.issue);
	async function copy() {
		copyMessage = (await copyToClipboard(JSON.stringify(draft.current, null, 2)))
			? m.issues_copied()
			: m.issues_copy_failed();
	}
	function reload() {
		const conflict = draft.conflict;
		if (!conflict) return;
		draft.discard();
		if (conflict.comment)
			draft.beginEditing({ body: conflict.comment.body ?? '' }, conflict.comment.revision);
		else if (conflict.issue?.id === draft.current.issueId)
			draft.beginEditing(
				draft.current.kind === 'close'
					? { resolution: conflict.issue.resolution ?? 'done', body: '' }
					: issueEditorFields(conflict.issue),
				conflict.issue.revision,
			);
	}
</script>

{#if draft.error || draft.recoveryWarning || draft.current.frozen}
	<div class="issue-notice" role="status">
		{#if draft.error}<p>{draft.error}</p>{/if}
		{#if draft.recoveryWarning}<p>{draft.recoveryWarning}</p>{/if}
		{#if current}
			<details>
				<summary>{m.issues_server_version()}</summary>
				<pre class="issue-conflict">{JSON.stringify(current, null, 2)}</pre>
			</details>
			{#if draft.current.kind !== 'mutation' && current.id === (draft.current.commentId ?? draft.current.issueId)}
				<button
					type="button"
					class="issue-button"
					onclick={() => draft.reviewRevision(current.revision)}
					disabled={!draft.canEdit}>{m.issues_review()}</button
				>
				<button type="button" class="issue-button" onclick={reload} disabled={!draft.canEdit}
					>{m.issues_reload_version()}</button
				>
			{/if}
		{/if}
		<div class="issue-actions">
			{#if draft.canRetry}<button
					type="button"
					class="issue-button"
					onclick={() => void draft.retry()}>{m.issues_retry_same()}</button
				>{/if}
			<button type="button" class="issue-button" onclick={() => void copy()}
				>{m.issues_copy()}</button
			>
			<button
				type="button"
				class="issue-button"
				disabled={draft.pending}
				onclick={() => (discard = true)}>{m.issues_discard()}</button
			>
		</div>
		{#if discard}<p>{m.issues_discard_confirm()}</p>
			<button
				type="button"
				class="issue-button"
				onclick={() => {
					draft.discard();
					discard = false;
				}}>{m.issues_discard()}</button
			><button type="button" class="issue-button" onclick={() => (discard = false)}
				>{m.issues_keep()}</button
			>{/if}
		{#if copyMessage}<p>{copyMessage}</p>{/if}
	</div>
{/if}
