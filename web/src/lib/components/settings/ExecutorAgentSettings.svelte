<script lang="ts">
	import { untrack } from 'svelte';
	import { getModelCatalog, getExecutors } from '$lib/context';
	import { nativeSourceLabelFor } from '$lib/agents/agent-labels';
	import { SettingsAuthState } from './settings-auth-state.svelte.js';
	import AgentCard from './AgentCard.svelte';
	import OtherAgentsSection from './OtherAgentsSection.svelte';

	let { executorId, section }: { executorId: string; section: 'native' | 'other-agents' } = $props();
	const catalog = getModelCatalog();
	const executors = getExecutors();
	const authExecutorId = $derived(executorId);
	const settingsAuth = $derived(new SettingsAuthState(catalog.forExecutor(authExecutorId), authExecutorId));
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
</script>

{#if !ready}
	<p class="text-sm text-muted-foreground">{executors.label(executorId)} is unavailable.</p>
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
	</div>
{/if}
