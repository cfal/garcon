<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { agentLabelFor } from '$lib/i18n/agent-labels';
	import AgentCard from './AgentCard.svelte';
	import type { SettingsAuthState } from './settings-auth-state.svelte.js';

	type AgentConfig = {
		id: 'opencode' | 'amp' | 'cursor' | 'factory' | 'pi';
		loginCommand: string;
	};

	const agents: AgentConfig[] = [
		{ id: 'amp', loginCommand: 'amp login' },
		{ id: 'cursor', loginCommand: 'cursor-agent login' },
		{ id: 'factory', loginCommand: 'droid' },
		{ id: 'opencode', loginCommand: 'opencode auth login' },
		{ id: 'pi', loginCommand: 'pi' }
	];

	let { settingsAuth }: { settingsAuth: SettingsAuthState } = $props();

	let openByAgent = $state<Record<string, boolean>>({});

	function isOpen(agentId: string): boolean {
		return openByAgent[agentId] ?? false;
	}

	function setOpen(agentId: string, open: boolean): void {
		openByAgent = { ...openByAgent, [agentId]: open };
	}
</script>

<section class="space-y-4">
	<p class="text-sm text-muted-foreground">
		{m.settings_other_agents_description()}
	</p>

	<div class="space-y-3">
		{#each agents as agent (agent.id)}
			<AgentCard
				agentId={agent.id}
				agentName={agentLabelFor(agent.id)}
				auth={settingsAuth.authFor(agent.id)}
				open={isOpen(agent.id)}
				onOpenChange={(open) => setOpen(agent.id, open)}
				cliOnly={true}
				loginCommand={agent.loginCommand}
				readiness={settingsAuth.readinessFor(agent.id)}
			/>
		{/each}
	</div>
</section>
