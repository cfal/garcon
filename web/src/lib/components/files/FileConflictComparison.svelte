<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';

	const conflictDiff = lazyRenderer(() => import('./FileConflictDiff.svelte'));

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
	let initializedSnapshot: {
		baseContent: string;
		localContent: string;
		diskContent: string | null;
	} | null = null;
	let resolvedContent = $state('');
	$effect.pre(() => {
		if (
			initializedSnapshot?.baseContent === baseContent &&
			initializedSnapshot.localContent === localContent &&
			initializedSnapshot.diskContent === diskContent
		) {
			return;
		}
		initializedSnapshot = { baseContent, localContent, diskContent };
		resolvedContent = localContent;
	});
	const comparison = $derived(selected === 'base' ? baseContent : (diskContent ?? ''));

	function selectSnapshot(event: KeyboardEvent): void {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		selected = selected === 'base' ? 'disk' : 'base';
	}
</script>

<div class="space-y-4">
	<div
		class="flex gap-2"
		role="tablist"
		aria-label="Conflict snapshots"
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
			onclick={() => (selected = 'base')}>Base</Button
		>
		<Button
			id="file-conflict-disk-tab"
			variant={selected === 'disk' ? 'default' : 'outline'}
			size="sm"
			role="tab"
			aria-controls="file-conflict-comparison-panel"
			aria-selected={selected === 'disk'}
			tabindex={selected === 'disk' ? 0 : -1}
			onclick={() => (selected = 'disk')}>Disk</Button
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
				Preparing comparison…
			</div>
		{:then FileConflictDiff}
			<FileConflictDiff {comparison} {lineSeparator} bind:local={resolvedContent} />
		{:catch error}
			<div
				class="rounded-md border border-status-error-border bg-status-error p-3 text-sm text-status-error-foreground"
			>
				{error instanceof Error ? error.message : 'The comparison could not be displayed.'}
			</div>
		{/await}
	</div>
	<div class="flex flex-wrap justify-end gap-2">
		<Button variant="ghost" onclick={onCancel}>Cancel</Button>
		<Button variant="outline" onclick={onAcceptDisk} disabled={diskContent === null}
			>Accept disk</Button
		>
		<Button onclick={() => onSaveChecked(resolvedContent)} disabled={diskContent === null}
			>Save against displayed disk</Button
		>
		<Button
			variant="destructive"
			onclick={() => onOverwrite(resolvedContent)}
			disabled={diskContent === null}>Replace disk</Button
		>
	</div>
</div>
