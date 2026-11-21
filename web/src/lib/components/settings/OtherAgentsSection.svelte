<script lang="ts">
	import { agentLabelFor } from '$lib/agents/agent-labels';
	import AgentCard from './AgentCard.svelte';
	import type { SettingsAuthState } from './settings-auth-state.svelte.js';

	export type OtherAgentsAuth = Pick<
		SettingsAuthState,
		| 'authFor'
		| 'readinessFor'
		| 'supportsAuthLogin'
		| 'deviceAuthFor'
		| 'isLoginPending'
		| 'handleLogin'
		| 'completeLogin'
	>;

	type AgentConfig = {
		id: 'opencode' | 'amp' | 'antigravity' | 'cursor' | 'factory' | 'pi';
		loginCommand: string;
	};

	const agents: AgentConfig[] = [
		{ id: 'amp', loginCommand: 'amp login' },
		{ id: 'antigravity', loginCommand: 'agy acp --login' },
		{ id: 'cursor', loginCommand: 'cursor-agent login' },
		{ id: 'factory', loginCommand: 'droid' },
		{ id: 'opencode', loginCommand: 'opencode auth login' },
		{ id: 'pi', loginCommand: 'pi' },
	];

	let { settingsAuth }: { settingsAuth: OtherAgentsAuth } = $props();

	let openByAgent = $state<Record<string, boolean>>({});

	function isOpen(agentId: string): boolean {
		return openByAgent[agentId] ?? false;
	}

	function setOpen(agentId: string, open: boolean): void {
		openByAgent = { ...openByAgent, [agentId]: open };
	}
</script>

<section class="space-y-4">
	<div class="space-y-3">
		{#each agents as agent (agent.id)}
			<AgentCard
				agentId={agent.id}
				agentName={agentLabelFor(agent.id)}
				auth={settingsAuth.authFor(agent.id)}
				open={isOpen(agent.id)}
				onOpenChange={(open) => setOpen(agent.id, open)}
				cliOnly={!settingsAuth.supportsAuthLogin(agent.id)}
				loginCommand={agent.loginCommand}
				readiness={settingsAuth.readinessFor(agent.id)}
				deviceAuth={settingsAuth.deviceAuthFor(agent.id)}
				pending={settingsAuth.isLoginPending(agent.id)}
				onLogin={() => settingsAuth.handleLogin(agent.id)}
				onCompleteLogin={(code) => {
					void settingsAuth.completeLogin(agent.id, code);
				}}
			/>
		{/each}
	</div>
</section>
