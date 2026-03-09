<!-- Agents settings section. Renders collapsible cards for each provider
     with auth status and login actions. Primary providers (Claude, Codex,
     OpenCode) are always visible; Amp is grouped under a collapsible
     "More providers" toggle. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { getAuthStatus } from '$lib/api/providers.js';
	import AgentCard from './AgentCard.svelte';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	interface AuthStatus {
		authenticated: boolean;
		email: string | null;
		loading: boolean;
		error: string | null;
	}

	type AgentId = 'claude' | 'codex' | 'opencode' | 'amp';

	const DEFAULT_AUTH: AuthStatus = { authenticated: false, email: null, loading: true, error: null };

	const primaryAgents: { id: AgentId; name: string }[] = [
		{ id: 'claude', name: 'Claude' },
		{ id: 'codex', name: 'Codex' },
		{ id: 'opencode', name: 'OpenCode' }
	];

	const secondaryAgents: { id: AgentId; name: string }[] = [
		{ id: 'amp', name: 'Amp' }
	];

	let claudeAuth = $state<AuthStatus>({ ...DEFAULT_AUTH });
	let codexAuth = $state<AuthStatus>({ ...DEFAULT_AUTH });
	let opencodeAuth = $state<AuthStatus>({ ...DEFAULT_AUTH });
	let ampAuth = $state<AuthStatus>({ ...DEFAULT_AUTH });

	let claudeOpen = $state(false);
	let codexOpen = $state(false);
	let opencodeOpen = $state(false);
	let ampOpen = $state(false);

	let moreProvidersOpen = $state(false);

	function authFor(agent: AgentId): AuthStatus {
		if (agent === 'claude') return claudeAuth;
		if (agent === 'codex') return codexAuth;
		if (agent === 'amp') return ampAuth;
		return opencodeAuth;
	}

	function isOpen(agent: AgentId): boolean {
		if (agent === 'claude') return claudeOpen;
		if (agent === 'codex') return codexOpen;
		if (agent === 'amp') return ampOpen;
		return opencodeOpen;
	}

	function setOpen(agent: AgentId, value: boolean) {
		if (agent === 'claude') claudeOpen = value;
		else if (agent === 'codex') codexOpen = value;
		else if (agent === 'amp') ampOpen = value;
		else opencodeOpen = value;
	}

	async function checkAuth(agent: AgentId) {
		const setAuth = (status: AuthStatus) => {
			if (agent === 'claude') claudeAuth = status;
			else if (agent === 'codex') codexAuth = status;
			else if (agent === 'amp') ampAuth = status;
			else opencodeAuth = status;
		};

		try {
			const data = await getAuthStatus(agent) as Record<string, unknown>;
			setAuth({
				authenticated: Boolean(data.authenticated),
				email: (data.email as string) || null,
				loading: false,
				error: (data.error as string) || null
			});
		} catch (err) {
			setAuth({
				authenticated: false,
				email: null,
				loading: false,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	function handleLogin(agent: AgentId) {
		if (agent === 'amp') return;
		const loginUrl = `/api/v1/${agent}/auth/login`;
		window.open(loginUrl, '_blank', 'width=800,height=600');
	}

	// Count how many secondary providers are connected
	let secondaryConnectedCount = $derived(
		[ampAuth].filter((a) => a.authenticated).length
	);

	let authExpandDone = $state(false);
	$effect(() => {
		const allLoaded = !claudeAuth.loading && !codexAuth.loading && !opencodeAuth.loading && !ampAuth.loading;
		if (allLoaded && !authExpandDone) {
			authExpandDone = true;
			if (!claudeAuth.authenticated) claudeOpen = true;
			if (!codexAuth.authenticated) codexOpen = true;
			if (!opencodeAuth.authenticated) opencodeOpen = true;
			// Auto-expand the "More providers" section if Amp is connected
			if (ampAuth.authenticated) {
				moreProvidersOpen = true;
			}
			if (!ampAuth.authenticated) ampOpen = true;
		}
	});

	onMount(() => {
		checkAuth('claude');
		checkAuth('codex');
		checkAuth('opencode');
		checkAuth('amp');
	});
</script>

<section data-section="agents" class="space-y-3">
	{#each primaryAgents as agent (agent.id)}
		<AgentCard
			agentId={agent.id}
			agentName={agent.name}
			auth={authFor(agent.id)}
			open={isOpen(agent.id)}
			onOpenChange={(v) => setOpen(agent.id, v)}
			onLogin={() => handleLogin(agent.id)}
		/>
	{/each}

	<!-- Secondary providers toggle -->
	<div class="pt-1">
		<button
			type="button"
			class="flex w-full items-center gap-2 px-1 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
			onclick={() => (moreProvidersOpen = !moreProvidersOpen)}
		>
			<ChevronDownIcon class="size-3.5 shrink-0 transition-transform duration-200 {moreProvidersOpen ? 'rotate-180' : ''}" />
			<span>More providers</span>
			{#if !moreProvidersOpen && secondaryConnectedCount > 0}
				<span class="ml-auto text-xs text-muted-foreground/70">{secondaryConnectedCount} connected</span>
			{/if}
		</button>

		{#if moreProvidersOpen}
			<div class="mt-2 space-y-3">
				{#each secondaryAgents as agent (agent.id)}
					<AgentCard
						agentId={agent.id}
						agentName={agent.name}
						auth={authFor(agent.id)}
						open={isOpen(agent.id)}
						onOpenChange={(v) => setOpen(agent.id, v)}
						onLogin={() => handleLogin(agent.id)}
						cliOnly={agent.id === 'amp'}
					/>
				{/each}
			</div>
		{/if}
	</div>
</section>
