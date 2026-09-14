<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';

	let { session, compact = false }: { session: FileViewSession; compact?: boolean } = $props();
	let expanded = $state(false);
	const status = $derived(session.editor?.status);
	const saveLabel = $derived.by(() => {
		if (session.saveOutcomeUnknown) return m.editor_status_save_unknown();
		if (session.document.mixedLineEndings) return m.editor_status_mixed_endings();
		if (session.document.missing) return m.editor_status_missing();
		if (session.readOnly) return m.editor_status_read_only();
		if (session.document.recoveryError) return m.editor_status_recovery_failed();
		if (session.saving) return m.editor_actions_saving();
		if (session.document.recovered) return m.editor_status_recovered();
		if (session.isExternallyStale) return m.editor_status_disk_changed();
		if (session.dirty) return m.editor_status_modified();
		return m.editor_actions_saved();
	});
</script>

<footer
	class="relative flex min-h-7 shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 text-[11px] text-muted-foreground"
	aria-label={m.editor_status_title()}
	role="group"
>
	{#if compact}
		<button
			type="button"
			class="absolute inset-0 z-10 rounded-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			aria-label={m.editor_status_show_full()}
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		></button>
	{/if}
	<span
		role="status"
		class="truncate"
		class:text-status-warning-foreground={session.dirty || session.saveOutcomeUnknown}
		>{saveLabel}</span
	>
	{#if status}
		<div class="flex items-center gap-3 whitespace-nowrap">
			<span>{m.editor_status_location({ line: status.line, column: status.column })}</span>
			{#if status.selectedCharacters > 0}<span
					>{m.editor_status_selected({ count: status.selectedCharacters })}</span
				>{/if}
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
			aria-label={m.editor_status_full()}
		>
			<div class="flex items-center justify-between gap-3">
				<strong>{m.editor_status_title()}</strong>
				<button
					type="button"
					class="rounded-md px-3 py-2 text-base hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onclick={() => (expanded = false)}>{m.editor_actions_close()}</button
				>
			</div>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
				<dt>{m.editor_status_position()}</dt>
				<dd>{m.editor_status_location({ line: status.line, column: status.column })}</dd>
				<dt>{m.editor_status_indentation()}</dt>
				<dd>{status.indentation}</dd>
				<dt>{m.editor_status_line_endings()}</dt>
				<dd>{status.eol}</dd>
				<dt>{m.editor_status_syntax()}</dt>
				<dd>{status.syntax}</dd>
			</dl>
		</div>
	{/if}
</footer>
