<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { untrack } from 'svelte';
	import { getModelCatalog, getExecutors } from '$lib/context';
	import { nativeSourceLabelFor } from '$lib/agents/agent-labels';
	import { SettingsAuthState } from './settings-auth-state.svelte.js';
	import AgentCard from './AgentCard.svelte';
	import AgentCliUpdatePanel from './AgentCliUpdatePanel.svelte';
	import OtherAgentsSection from './OtherAgentsSection.svelte';

	let { executorId, section }: { executorId: string; section: 'native' | 'other-agents' } = $props();
	const catalog = getModelCatalog();
	const executors = getExecutors();
	const authExecutorId = $derived(executorId);
	const settingsAuth = $derived(new SettingsAuthState(catalog.forExecutor(authExecutorId), authExecutorId));
	let openByAgent = $state<Record<string, boolean>>({});
	const instanceId = $derived.by(() => {
		const executor = executors.get(executorId);
		if (!executor?.enabled || executor.availability !== 'ready') return null;
		return executor.instanceId;
	});
	const ready = $derived(instanceId !== null);

	$effect(() => {
		const auth = settingsAuth;
		if (instanceId) return untrack(() => auth.initialize());
	});
</script>

{#if !ready}
	<p class="text-sm text-muted-foreground">{m.executors_named_unavailable({ label: executors.label(executorId) })}</p>
{:else if section === 'other-agents'}
	<OtherAgentsSection {settingsAuth} />
{:else}
	<div class="space-y-3">
		{#each ['claude', 'codex'] as agentId (agentId)}
			{#snippet installation()}
				{#if instanceId}
					<AgentCliUpdatePanel {agentId} {executorId} {instanceId} />
				{/if}
			{/snippet}
			<AgentCard
				{agentId}
				agentName={nativeSourceLabelFor(agentId)}
				auth={settingsAuth.authFor(agentId)}
				readiness={settingsAuth.readinessFor(agentId)}
				deviceAuth={settingsAuth.deviceAuthFor(agentId)}
				pending={settingsAuth.isLoginPending(agentId)}
				children={agentId === 'claude' ? installation : undefined}
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
	</div>
{/if}
