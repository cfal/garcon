<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { untrack } from 'svelte';
	import { getModelCatalog, getExecutors } from '$lib/context';
	import { nativeSourceLabelFor } from '$lib/agents/agent-labels';
	import { SettingsAuthState } from './settings-auth-state.svelte.js';
	import { SettingsCliUpdateState } from './settings-cli-update-state.svelte.js';
	import AgentCard from './AgentCard.svelte';
	import AgentCliUpdateRow from './AgentCliUpdateRow.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import OtherAgentsSection from './OtherAgentsSection.svelte';

	let { executorId, section }: { executorId: string; section: 'native' | 'other-agents' } = $props();
	const catalog = getModelCatalog();
	const executors = getExecutors();
	const authExecutorId = $derived(executorId);
	const settingsAuth = $derived(new SettingsAuthState(catalog.forExecutor(authExecutorId), authExecutorId));
	const cliUpdates = $derived(new SettingsCliUpdateState(executorId));
	let openByAgent = $state<Record<string, boolean>>({});
	const authContext = $derived.by(() => {
		const executor = executors.get(executorId);
		if (!executor?.enabled || executor.availability !== 'ready') return null;
		return JSON.stringify([executor.id, executor.instanceId]);
	});
	const ready = $derived(authContext !== null);

	$effect(() => {
		const auth = settingsAuth;
		if (authContext) return untrack(() => auth.initialize());
	});

	// Version checks run only while the native section is visible on a ready executor.
	$effect(() => {
		const updates = cliUpdates;
		if (authContext && section === 'native') return untrack(() => updates.initialize());
	});
</script>

{#if !ready}
	<p class="text-sm text-muted-foreground">{m.executors_named_unavailable({ label: executors.label(executorId) })}</p>
{:else if section === 'other-agents'}
	<OtherAgentsSection {settingsAuth} />
{:else}
	<div class="space-y-3">
		{#each ['claude', 'codex'] as agentId (agentId)}
			<AgentCard
				{agentId}
				agentName={nativeSourceLabelFor(agentId)}
				auth={settingsAuth.authFor(agentId)}
				readiness={settingsAuth.readinessFor(agentId)}
				deviceAuth={settingsAuth.deviceAuthFor(agentId)}
				pending={settingsAuth.isLoginPending(agentId)}
				open={openByAgent[agentId] ?? false}
				onOpenChange={(open) => {
					openByAgent[agentId] = open;
				}}
				onLogin={() => settingsAuth.handleLogin(agentId)}
				onCompleteLogin={(code) => {
					void settingsAuth.completeLogin(agentId, code);
				}}
			/>
		{/each}
		<div class="rounded-lg border border-border divide-y divide-border">
			<div class="flex flex-wrap items-center gap-3 px-4 py-3">
				<h3 class="flex-1 font-medium text-foreground">{m.settings_cli_updates_heading()}</h3>
				<Button
					variant="outline"
					size="sm"
					onclick={() => void cliUpdates.checkForUpdates()}
					disabled={cliUpdates.checking}
				>
					{#if cliUpdates.checking}
						<LoaderIcon class="size-3.5 mr-1.5 animate-spin" />
						{m.settings_cli_update_checking()}
					{:else}
						<RefreshCwIcon class="size-3.5 mr-1.5" />
						{m.settings_cli_update_check_button()}
					{/if}
				</Button>
			</div>
			{#if cliUpdates.loadError}
				<p role="alert" class="px-4 py-3 text-sm text-destructive break-words">
					{m.settings_cli_update_error({ error: cliUpdates.loadError })}
				</p>
			{/if}
			{#each ['claude', 'codex'] as agentId (agentId)}
				<AgentCliUpdateRow
					agentName={nativeSourceLabelFor(agentId)}
					status={cliUpdates.statusFor(agentId)}
					failure={cliUpdates.failureFor(agentId)}
					starting={cliUpdates.isStarting(agentId)}
					onUpdate={() => void cliUpdates.startUpdate(agentId)}
				/>
			{/each}
		</div>
	</div>
{/if}
