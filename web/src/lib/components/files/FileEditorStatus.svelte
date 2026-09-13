<script lang="ts">
	import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';

	let { session, compact = false }: { session: FileViewSession; compact?: boolean } = $props();
	let expanded = $state(false);
	const status = $derived(session.editor?.status);
	const saveLabel = $derived.by(() => {
		if (session.saveOutcomeUnknown) return 'Save outcome unknown';
		if (session.document.mixedLineEndings) return 'Read only: mixed line endings';
		if (session.document.missing) return 'Missing on disk';
		if (session.readOnly) return 'Read only';
		if (session.document.recoveryError) return 'Recovery failed';
		if (session.saving) return 'Saving';
		if (session.document.recovered) return 'Recovered';
		if (session.isExternallyStale) return 'Changed on disk';
		if (session.dirty) return 'Modified';
		return 'Saved';
	});
</script>

<footer
	class="relative flex min-h-7 shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 text-[11px] text-muted-foreground"
	aria-label="Editor status"
	role="status"
	aria-live="polite"
>
	{#if compact}
		<button
			type="button"
			class="absolute inset-0 z-10 rounded-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label="Show full editor status"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		></button>
	{/if}
	<span class="truncate" class:text-status-warning-foreground={session.dirty || session.saveOutcomeUnknown}
		>{saveLabel}</span
	>
	{#if status}
		<div class="flex items-center gap-3 whitespace-nowrap">
			<span>Ln {status.line}, Col {status.column}</span>
			{#if status.selectedCharacters > 0}<span>{status.selectedCharacters} selected</span>{/if}
			{#if !compact}
				<span>{status.indentation}</span>
				<span>{status.eol}</span>
				<span>{status.syntax}</span>
			{/if}
		</div>
	{/if}
	{#if compact && expanded && status}
		<div
			class="fixed inset-x-3 bottom-3 z-50 grid gap-3 rounded-lg border border-border bg-popover p-4 text-base text-foreground shadow-2xl"
			role="dialog"
			aria-label="Full editor status"
		>
			<div class="flex items-center justify-between gap-3">
				<strong>Editor status</strong>
				<button
					type="button"
					class="rounded-md px-3 py-2 text-base hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onclick={() => (expanded = false)}
				>Close</button>
			</div>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
				<dt>Position</dt><dd>Ln {status.line}, Col {status.column}</dd>
				<dt>Indentation</dt><dd>{status.indentation}</dd>
				<dt>Line endings</dt><dd>{status.eol}</dd>
				<dt>Syntax</dt><dd>{status.syntax}</dd>
			</dl>
		</div>
	{/if}
</footer>
