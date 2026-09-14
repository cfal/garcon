<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { getFileSessions } from '$lib/context';
	import type { FileRecoveryChoice } from '$lib/files/documents/file-document-state.svelte.js';
	import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';

	let { session }: { session: FileViewSession } = $props();
	const files = getFileSessions();
	const diff = lazyRenderer(() => import('./FileConflictDiff.svelte'));
	let selectedId = $state<string | null>(null);
	let comparisonReady = $state(false);
	const selected = $derived(
		session.document.recoveredCopies.find((copy) => copy.id === selectedId),
	);
	const busy = $derived(session.document.resolvingRecovery);
	const choiceDisabled = $derived(
		!comparisonReady ||
			busy ||
			session.document.recoveryGuard ||
			session.document.saveController !== null ||
			session.document.pendingMutationCount > 0,
	);

	async function choose(choice: FileRecoveryChoice): Promise<void> {
		if (!selected) return;
		if (await files.resolveRecoveredCopy(session.id, selected.id, choice)) selectedId = null;
	}
</script>

<section
	class="max-h-44 shrink-0 overflow-auto border-b border-status-warning-border bg-status-warning px-3 py-2 text-xs text-status-warning-foreground"
	aria-label={m.file_recovery_copy_title()}
>
	{#each session.document.recoveredCopies as copy, index (copy.id)}
		<svelte:boundary>
			<div class="flex flex-wrap items-center gap-2 py-1">
				<span class="min-w-0 flex-1"
					>{m.file_recovery_copy_title()}
					<time datetime={new Date(copy.savedAt).toISOString()}
						>{new Date(copy.savedAt).toLocaleString()}</time
					></span
				>
				<Button
					variant="outline"
					size="sm"
					onclick={() => (selectedId = copy.id)}
					aria-label={m.file_recovery_compare_named({
						number: index + 1,
						savedAt: new Date(copy.savedAt).toLocaleString(),
					})}>{m.file_session_compare()}</Button
				>
				<Button
					variant="outline"
					size="sm"
					onclick={() => void files.exportContent(session.id, copy.id)}
					aria-label={m.file_recovery_export_named({
						number: index + 1,
						savedAt: new Date(copy.savedAt).toLocaleString(),
					})}>{m.file_recovery_export_copy()}</Button
				>
			</div>
			{#snippet failed()}{m.file_recovery_resolution_failed()}{/snippet}
		</svelte:boundary>
	{/each}
</section>

<Dialog.Root
	open={Boolean(selected)}
	requestClose={() => {
		if (!busy) selectedId = null;
	}}
>
	<Dialog.Content class="max-w-[calc(100vw-2rem)] sm:max-w-5xl" showCloseButton={false}>
		<Dialog.Header>
			<Dialog.Title>{m.file_recovery_copy_title()}</Dialog.Title>
			<Dialog.Description
				>{m.file_recovery_copy_description({ fileName: session.fileName })}</Dialog.Description
			>
		</Dialog.Header>
		{#if selected}
			<div class="grid grid-cols-2 gap-4 text-sm font-medium">
				<span>{m.file_recovery_current_copy()}</span><span>{m.file_recovery_copy_title()}</span>
			</div>
			{#await diff()}
				<p>{m.file_conflict_preparing()}</p>
			{:then FileConflictDiff}
				{#key selected}
					<FileConflictDiff
						comparison={session.document.currentContent()}
						local={selected.content}
						lineSeparator={session.document.lineSeparator}
						readOnly
						comparisonLabel={m.file_recovery_current_copy()}
						localLabel={m.file_recovery_copy_title()}
						onReady={(ready) => (comparisonReady = ready)}
					/>
				{/key}
			{:catch}
				<p role="alert">{m.file_conflict_failed()}</p>
			{/await}
			{#if selected.hasUnknownSubmission || session.saveOutcomeUnknown}
				<p class="text-sm">{m.file_recovery_copy_unknown()}</p>
			{/if}
			{#if session.document.recoveryResolutionError}
				<p role="alert" class="text-sm text-status-error-foreground">
					{session.document.recoveryResolutionError}
				</p>
				<Button
					variant="outline"
					disabled={busy}
					onclick={() => void files.retryRecoveryDiscovery()}>{m.file_recovery_retry()}</Button
				>
			{/if}
			<div class="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" disabled={busy} onclick={() => (selectedId = null)}
					>{m.common_cancel()}</Button
				>
				<Button
					variant="outline"
					disabled={choiceDisabled}
					onclick={() => void choose('keep-current')}>{m.file_recovery_keep_current()}</Button
				>
				<Button disabled={choiceDisabled} onclick={() => void choose('use-recovered')}
					>{m.file_recovery_use_recovered()}</Button
				>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
