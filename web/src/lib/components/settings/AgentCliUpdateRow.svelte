<!-- Renders one agent's native CLI version and its update controls. -->
<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ArrowUpCircleIcon from '@lucide/svelte/icons/circle-arrow-up';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard.js';
	import type { AgentCliUpdateStatus } from '$shared/agent-cli-update';
	import { agentCliUpdateView } from './agent-cli-update-view.js';

	let {
		agentName,
		status,
		failure,
		starting = false,
		onUpdate,
	}: {
		agentName: string;
		status: AgentCliUpdateStatus | undefined;
		failure: string | undefined;
		starting?: boolean;
		onUpdate: () => void;
	} = $props();

	let copied = $state(false);
	let showOutput = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => () => {
		if (copiedTimer) clearTimeout(copiedTimer);
	});
	const view = $derived(status ? agentCliUpdateView(status) : null);
	// A failed check reports no status, so the row falls back to the agent's name.
	const label = $derived(status?.cliLabel ?? agentName);
	const busy = $derived(starting || view?.running === true);

	async function copyCommand() {
		if (!status?.updateCommand) return;
		copied = await copyToClipboard(status.updateCommand);
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = copied ? setTimeout(() => (copied = false), 2000) : null;
	}
</script>

<div class="space-y-2 px-4 py-3 text-sm" aria-label={label} role="group">
	<div class="flex flex-wrap items-center gap-2">
		<span class="font-medium text-foreground">{label}</span>
		{#if status}
			<span class="font-mono text-foreground" title={status.installPath ?? undefined}>
				{status.currentVersion ?? m.settings_cli_update_version_unknown()}
			</span>
			{#if view?.updateAvailable && status.latestVersion}
				<Badge class="text-xs bg-status-warning text-status-warning-foreground border-status-warning-border">
					{m.settings_cli_update_available({ version: status.latestVersion })}
				</Badge>
			{:else if status.advisory === 'current'}
				<Badge class="text-xs bg-status-success text-status-success-foreground border-status-success-border">
					{m.settings_cli_update_current()}
				</Badge>
			{/if}
		{/if}
		{#if view?.action === 'update' || busy}
			<Button class="ml-auto" variant="outline" size="sm" onclick={onUpdate} disabled={busy}>
				{#if busy}
					<LoaderIcon class="size-3.5 mr-1.5 animate-spin" />
					{m.settings_cli_update_running()}
				{:else}
					<ArrowUpCircleIcon class="size-3.5 mr-1.5" />
					{m.settings_cli_update_button()}
				{/if}
			</Button>
		{/if}
	</div>

	{#if view?.running && status?.run.message}
		<p role="status" aria-live="polite" class="text-xs text-muted-foreground break-words">{status.run.message}</p>
	{:else if status && view?.outcome}
		<p
			role={view.outcome === 'succeeded' ? 'status' : 'alert'}
			class="text-xs break-words {view.outcome === 'succeeded' ? 'text-muted-foreground' : 'text-destructive'}"
		>
			{status.run.message}
			{#if view.outcome === 'succeeded'}{m.settings_cli_update_new_sessions()}{/if}
		</p>
		{#if status.run.output && view.outcome !== 'succeeded'}
			<Button variant="ghost" size="sm" class="h-auto px-0 text-xs" onclick={() => (showOutput = !showOutput)}>
				{showOutput ? m.settings_cli_update_hide_output() : m.settings_cli_update_show_output()}
			</Button>
			{#if showOutput}
				<pre class="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs text-foreground whitespace-pre-wrap">{status.run.output}</pre>
			{/if}
		{/if}
	{/if}

	{#if status?.message}
		<p class="text-xs text-muted-foreground break-words">{status.message}</p>
	{/if}

	{#if view?.action === 'manual' && status?.updateCommand}
		<div class="flex items-center gap-2">
			<span class="text-xs text-muted-foreground">{m.settings_cli_update_manual()}</span>
			<code class="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{status.updateCommand}</code>
			<Button variant="ghost" size="icon-sm" onclick={copyCommand} aria-label={m.settings_cli_update_copy_command()}>
				{#if copied}
					<CheckIcon class="size-3.5 text-status-success" />
				{:else}
					<CopyIcon class="size-3.5" />
				{/if}
			</Button>
		</div>
	{/if}

	{#if failure}
		<p role="alert" class="text-xs text-destructive break-words">{m.settings_cli_update_error({ error: failure })}</p>
	{/if}
</div>
