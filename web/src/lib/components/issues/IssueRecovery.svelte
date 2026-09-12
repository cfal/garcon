<script lang="ts">
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import { copyToClipboard } from '$lib/utils/clipboard.js';
	import IssueDraftFeedback from './IssueDraftFeedback.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let { controller }: { controller: IssuesController } = $props();
	let message = $state('');
	let discardKey = $state<string | null>(null);
	const retained = $derived(
		controller.drafts.active.filter((draft) => draft.needsExitGuard && !draft.pending),
	);
	const unreadable = $derived(controller.drafts.entries.filter((entry) => !entry.draft));
	const memoryOnly = $derived(
		controller.drafts.oldStoreDrafts.filter(
			(draft) =>
				!controller.drafts.oldEntries.some(
					({ entry }) =>
						entry.draft?.id === draft.current.id && entry.draft.storeId === draft.current.storeId,
				),
		),
	);
	const count = $derived(
		retained.length + unreadable.length + controller.drafts.oldEntries.length + memoryOnly.length,
	);
	async function copy(text: string) {
		message = (await copyToClipboard(text)) ? m.issues_copied() : m.issues_copy_failed();
	}
</script>

{#if controller.drafts.warning}<p class="issue-notice" role="alert">
		{controller.drafts.warning}
	</p>{/if}
{#if count}
	<details class="issue-recovery">
		<summary>{m.issues_recovery()} · {count}</summary>
		<p class="issue-muted">{m.issues_recovery_hint()}</p>
		{#each retained as draft (draft.current.id)}<div class="issue-recovery-entry">
				<strong>{draft.current.issueId ?? m.issues_new()} · {draft.current.kind}</strong><button
					type="button"
					class="issue-text-button"
					onclick={() => controller.openDraft(draft)}>{m.issues_recovery_open()}</button
				>
				<button
					type="button"
					class="issue-text-button"
					onclick={() => void copy(JSON.stringify(draft.current, null, 2))}
					>{m.issues_copy()}</button
				>
				<button
					type="button"
					class="issue-text-button"
					disabled={draft.pending}
					onclick={() => (discardKey = draft.current.id)}>{m.issues_discard()}</button
				>
				{#if discardKey === draft.current.id}<p>{m.issues_discard_confirm()}</p>
					<button
						class="issue-button"
						onclick={() => {
							draft.discard();
							discardKey = null;
						}}>{m.issues_discard()}</button
					><button class="issue-button" onclick={() => (discardKey = null)}
						>{m.issues_keep()}</button
					>{/if}
				<IssueDraftFeedback {draft} />
			</div>{/each}
		{#each unreadable as entry (entry.key)}<div class="issue-recovery-entry">
				<strong>{m.issues_unreadable()}</strong><button
					class="issue-text-button"
					onclick={() => void copy(entry.raw)}>{m.issues_copy_raw()}</button
				><button class="issue-text-button" onclick={() => (discardKey = entry.key)}
					>{m.issues_discard()}</button
				>
				{#if discardKey === entry.key}<p>{m.issues_discard_confirm()}</p>
					<button
						class="issue-button"
						onclick={() => {
							controller.drafts.discardEntry(entry);
							discardKey = null;
						}}>{m.issues_discard()}</button
					>{/if}
			</div>{/each}
		{#each controller.drafts.oldEntries as { partition, entry } (entry.key)}<div
				class="issue-recovery-entry"
			>
				<p>{m.issues_old_store()} · {entry.draft?.issueId ?? m.issues_new()}</p>
				<button class="issue-button" onclick={() => void copy(entry.raw)}
					>{m.issues_copy_raw()}</button
				>
				<button class="issue-button" onclick={() => (discardKey = entry.key)}
					>{m.issues_discard()}</button
				>
				{#if discardKey === entry.key}<p>{m.issues_discard_confirm()}</p>
					<button
						class="issue-button"
						onclick={() => {
							controller.drafts.discardOldEntry(partition, entry);
							discardKey = null;
						}}>{m.issues_discard()}</button
					><button class="issue-button" onclick={() => (discardKey = null)}
						>{m.issues_keep()}</button
					>{/if}
			</div>{/each}
		{#each memoryOnly as draft (`${draft.current.storeId}:${draft.current.id}`)}<div
				class="issue-recovery-entry"
			>
				<p>{m.issues_old_store()}</p>
				<button
					class="issue-button"
					onclick={() => void copy(JSON.stringify(draft.current, null, 2))}
					>{m.issues_copy()}</button
				>
				<button
					class="issue-button"
					disabled={draft.pending}
					onclick={() => (discardKey = `${draft.current.storeId}:${draft.current.id}`)}
					>{m.issues_discard()}</button
				>
				{#if discardKey === `${draft.current.storeId}:${draft.current.id}`}<p>
						{m.issues_discard_confirm()}
					</p>
					<button
						class="issue-button"
						onclick={() => {
							draft.discard();
							discardKey = null;
						}}>{m.issues_discard()}</button
					><button class="issue-button" onclick={() => (discardKey = null)}
						>{m.issues_keep()}</button
					>{/if}
				<IssueDraftFeedback {draft} />
			</div>{/each}
		{#if message}<p role="status">{message}</p>{/if}
	</details>
{/if}
