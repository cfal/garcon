<!-- Agents settings section. Renders collapsible cards for each provider
     with auth status and either UI login actions or CLI instructions.
     Primary providers are always visible; Amp is grouped under a
     collapsible "More providers" toggle. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { getAuthStatus, launchAuthLogin } from '$lib/api/providers.js';
	import AgentCard from './AgentCard.svelte';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	interface AuthStatus {
		authenticated: boolean;
		canReauth: boolean;
		label: string;
		loading: boolean;
		error: string | null;
	}

	type AgentId = 'claude' | 'codex' | 'opencode' | 'amp';
	type BrowserLoginAgentId = 'claude' | 'codex';
	type AgentConfig = { id: AgentId; name: string; cliOnly?: boolean; loginCommand?: string };

	const AUTH_POLL_INTERVAL_MS = 1500;
	const AUTH_POLL_TIMEOUT_MS = 5 * 60_000;

	const DEFAULT_AUTH: AuthStatus = { authenticated: false, canReauth: true, label: '', loading: true, error: null };

	const primaryAgents: AgentConfig[] = [
		{ id: 'claude', name: 'Claude' },
		{ id: 'codex', name: 'Codex' },
		{ id: 'opencode', name: 'OpenCode', cliOnly: true, loginCommand: 'opencode auth login' }
	];

	const secondaryAgents: AgentConfig[] = [
		{ id: 'amp', name: 'Amp', cliOnly: true, loginCommand: 'amp login' }
	];

	const authPollTimers: Partial<Record<AgentId, ReturnType<typeof setTimeout>>> = {};
	const authPollStartedAt: Partial<Record<AgentId, number>> = {};

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

	function setAuth(agent: AgentId, status: AuthStatus) {
		if (agent === 'claude') claudeAuth = status;
		else if (agent === 'codex') codexAuth = status;
		else if (agent === 'amp') ampAuth = status;
		else opencodeAuth = status;
	}

	async function checkAuth(agent: AgentId) {
		try {
			const data = await getAuthStatus(agent);
			setAuth(agent, {
				authenticated: data.authenticated,
				canReauth: data.canReauth,
				label: data.label,
				loading: false,
				error: null
			});
		} catch (err) {
			setAuth(agent, {
				authenticated: false,
				canReauth: true,
				label: '',
				loading: false,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	function stopAuthPolling(agent: AgentId) {
		const timer = authPollTimers[agent];
		if (timer) clearTimeout(timer);
		delete authPollTimers[agent];
		delete authPollStartedAt[agent];
	}

	async function pollAuthUntilAuthenticated(agent: AgentId) {
		await checkAuth(agent);
		if (authFor(agent).authenticated) {
			stopAuthPolling(agent);
			return;
		}

		const startedAt = authPollStartedAt[agent] ?? Date.now();
		if (Date.now() - startedAt >= AUTH_POLL_TIMEOUT_MS) {
			stopAuthPolling(agent);
			return;
		}

		authPollTimers[agent] = setTimeout(() => {
			void pollAuthUntilAuthenticated(agent);
		}, AUTH_POLL_INTERVAL_MS);
	}

	function startAuthPolling(agent: AgentId) {
		stopAuthPolling(agent);
		authPollStartedAt[agent] = Date.now();
		authPollTimers[agent] = setTimeout(() => {
			void pollAuthUntilAuthenticated(agent);
		}, AUTH_POLL_INTERVAL_MS);
	}

	async function handleLogin(agent: BrowserLoginAgentId) {
		setAuth(agent, { ...authFor(agent), error: null });

		try {
			await launchAuthLogin(agent);
			await checkAuth(agent);
			if (!authFor(agent).authenticated) {
				startAuthPolling(agent);
			}
		} catch (err) {
			stopAuthPolling(agent);
			setAuth(agent, {
				...authFor(agent),
				loading: false,
				error: err instanceof Error ? err.message : String(err)
			});
		}
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
		void checkAuth('claude');
		void checkAuth('codex');
		void checkAuth('opencode');
		void checkAuth('amp');

		return () => {
			stopAuthPolling('claude');
			stopAuthPolling('codex');
			stopAuthPolling('opencode');
			stopAuthPolling('amp');
		};
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
			onLogin={agent.cliOnly ? undefined : () => void handleLogin(agent.id as BrowserLoginAgentId)}
			cliOnly={agent.cliOnly ?? false}
			loginCommand={agent.loginCommand}
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
						cliOnly={agent.cliOnly ?? false}
						loginCommand={agent.loginCommand}
					/>
				{/each}
			</div>
		{/if}
	</div>
</section>
