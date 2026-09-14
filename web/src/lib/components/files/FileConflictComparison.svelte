<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { Button } from '$lib/components/ui/button';
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';

	const conflictDiff = lazyRenderer(() =>
		import('./FileConflictDiff.svelte').catch((error) => {
			console.error('Failed to load file conflict comparison', error);
			throw error;
		}),
	);

	let {
		baseContent,
		localContent,
		diskContent,
		lineSeparator,
		onCancel,
		onAcceptDisk,
		onSaveChecked,
		onOverwrite,
	}: {
		baseContent: string;
		localContent: string;
		diskContent: string | null;
		lineSeparator: '\n' | '\r' | '\r\n';
		onCancel(): void;
		onAcceptDisk(): void;
		onSaveChecked(content: string): void;
		onOverwrite(content: string): void;
	} = $props();
	let selected = $state<'base' | 'disk'>('disk');
	const snapshot = $derived({ baseContent, localContent, diskContent });
	let resolvedContent = $derived(snapshot.localContent);
	const comparison = $derived(selected === 'base' ? baseContent : (diskContent ?? ''));

	function selectSnapshot(event: KeyboardEvent): void {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		selected = selected === 'base' ? 'disk' : 'base';
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget
				.querySelector<HTMLButtonElement>(`#file-conflict-${selected}-tab`)
				?.focus();
		}
	}
</script>

<div class="space-y-4">
	<div
		class="flex gap-2"
		role="tablist"
		aria-label={m.file_conflict_snapshots()}
		tabindex="-1"
		onkeydown={selectSnapshot}
	>
		<Button
			id="file-conflict-base-tab"
			variant={selected === 'base' ? 'default' : 'outline'}
			size="sm"
			role="tab"
			aria-controls="file-conflict-comparison-panel"
			aria-selected={selected === 'base'}
			tabindex={selected === 'base' ? 0 : -1}
			onclick={() => (selected = 'base')}>{m.file_conflict_base()}</Button
		>
		<Button
			id="file-conflict-disk-tab"
			variant={selected === 'disk' ? 'default' : 'outline'}
			size="sm"
			role="tab"
			aria-controls="file-conflict-comparison-panel"
			aria-selected={selected === 'disk'}
			tabindex={selected === 'disk' ? 0 : -1}
			onclick={() => (selected = 'disk')}>{m.file_conflict_disk()}</Button
		>
	</div>
	<div
		id="file-conflict-comparison-panel"
		role="tabpanel"
		aria-labelledby={selected === 'base' ? 'file-conflict-base-tab' : 'file-conflict-disk-tab'}
		tabindex="0"
	>
		{#await conflictDiff()}
			<div
				class="grid h-64 place-items-center rounded-md border border-border text-sm text-muted-foreground"
			>
				{m.file_conflict_preparing()}
			</div>
		{:then FileConflictDiff}
			{#key snapshot}
				<FileConflictDiff {comparison} {lineSeparator} bind:local={resolvedContent} />
			{/key}
		{:catch}
			<div
				class="rounded-md border border-status-error-border bg-status-error p-3 text-sm text-status-error-foreground"
			>
				{m.file_conflict_failed()}
			</div>
		{/await}
	</div>
	<div class="flex flex-wrap justify-end gap-2">
		<Button variant="ghost" onclick={onCancel}>{m.common_cancel()}</Button>
		<Button variant="outline" onclick={onAcceptDisk} disabled={diskContent === null}
			>{m.file_conflict_accept_disk()}</Button
		>
		<Button onclick={() => onSaveChecked(resolvedContent)} disabled={diskContent === null}
			>{m.file_conflict_save_checked()}</Button
		>
		<Button
			variant="destructive"
			onclick={() => onOverwrite(resolvedContent)}
			disabled={diskContent === null}>{m.file_conflict_replace_disk()}</Button
		>
	</div>
</div>
