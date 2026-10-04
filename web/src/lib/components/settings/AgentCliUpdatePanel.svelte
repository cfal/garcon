<script lang="ts">
	import { untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import { AgentCliUpdateState } from './agent-cli-update-state.svelte.js';

	let {
		agentId,
		executorId,
		instanceId,
	}: { agentId: string; executorId: string; instanceId: string } = $props();
	const installationState = $derived(new AgentCliUpdateState(agentId, executorId, instanceId));
	const busy = $derived(installationState.loading || installationState.updating);

	$effect(() => {
		const current = installationState;
		return untrack(() => current.initialize());
	});
</script>

<section aria-label={m.settings_claude_code_title()} class="space-y-3 border-t border-border pt-3">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="min-w-0 space-y-1">
			<h3 class="text-sm font-medium text-foreground">{m.settings_claude_code_title()}</h3>
			<p class="text-xs text-muted-foreground">
				{#if installationState.loading}
					{m.settings_claude_code_checking()}
				{:else if installationState.installation}
					{m.settings_claude_code_version({ version: installationState.installation.version })}
				{/if}
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button type="button" variant="outline" size="sm" disabled={busy} onclick={() => installationState.refresh()}>
				{m.settings_claude_code_refresh()}
			</Button>
			<Button type="button" size="sm" disabled={busy} onclick={() => installationState.update()}>
				{installationState.updating ? m.settings_claude_code_updating() : m.settings_claude_code_update()}
			</Button>
		</div>
	</div>
	<p class="text-xs text-muted-foreground">{m.settings_claude_code_update_description()}</p>
	<div aria-live="polite" class="space-y-2 text-sm">
		{#if installationState.installation && !installationState.installation.supported}
			<p class="text-destructive">
				{m.settings_claude_code_unsupported({
					version: installationState.installation.version,
					minimumVersion: installationState.installation.minimumVersion,
				})}
			</p>
		{/if}
		{#if installationState.completed}
			<p class={installationState.installation?.supported ? 'text-status-success-foreground' : 'text-destructive'}>
				{installationState.installation?.supported
					? m.settings_claude_code_update_complete({ version: installationState.installation.version })
					: m.settings_claude_code_update_incomplete()}
			</p>
			{#if installationState.output}
				<details class="text-muted-foreground">
					<summary class="cursor-pointer">{m.settings_claude_code_update_details()}</summary>
					<pre class="mt-2 whitespace-pre-wrap break-all text-xs">{installationState.output}</pre>
				</details>
			{/if}
		{/if}
		{#if installationState.error}
			<p role="alert" class="text-destructive">{installationState.error}</p>
		{/if}
	</div>
</section>
