<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { getModelCatalog } from '$lib/context';
	import { nativeSourceLabelFor } from '$lib/i18n/harness-labels';
	import {
		getHarnessAuthStatus,
		getHarnessReadiness,
		launchHarnessAuthLogin,
		type DeviceAuthInfo,
		type HarnessReadiness
	} from '$lib/api/providers.js';
	import ApiProviderProtocolPanel from './ApiProviderProtocolPanel.svelte';
	import OtherHarnessesSection from './OtherHarnessesSection.svelte';

	interface AuthStatus {
		authenticated: boolean;
		canReauth: boolean;
		label: string;
		loading: boolean;
		error: string | null;
	}

	type HarnessId = 'claude' | 'codex' | 'opencode' | 'amp' | 'factory';
	type BrowserLoginHarnessId = 'claude' | 'codex';

	const AUTH_POLL_INTERVAL_MS = 1500;
	const AUTH_POLL_TIMEOUT_MS = 5 * 60_000;
	const DEFAULT_AUTH: AuthStatus = { authenticated: false, canReauth: true, label: '', loading: true, error: null };
	const harnessIds: HarnessId[] = ['claude', 'codex', 'opencode', 'amp', 'factory'];

	const modelCatalog = getModelCatalog();
	const authPollTimers: Partial<Record<HarnessId, ReturnType<typeof setTimeout>>> = {};
	const authPollSessionIds: Partial<Record<HarnessId, number>> = {};
	const authPollStartedAt: Partial<Record<HarnessId, number>> = {};
	let nextAuthPollSessionId = 0;

	let authByHarness = $state<Record<string, AuthStatus>>({});
	let readinessByHarness = $state<Record<string, HarnessReadiness>>({});
	let deviceAuthInfo = $state<Partial<Record<HarnessId, DeviceAuthInfo>>>({});
	let loginPending = $state<Partial<Record<HarnessId, boolean>>>({});

	function authFor(harnessId: HarnessId): AuthStatus {
		return authByHarness[harnessId] ?? { ...DEFAULT_AUTH };
	}

	function setAuth(harnessId: HarnessId, auth: AuthStatus): void {
		authByHarness = { ...authByHarness, [harnessId]: auth };
	}

	async function checkAuth(harnessId: HarnessId): Promise<void> {
		try {
			const data = await getHarnessAuthStatus(harnessId);
			setAuth(harnessId, {
				authenticated: data.authenticated,
				canReauth: data.canReauth,
				label: data.label,
				loading: false,
				error: null
			});
		} catch (err) {
			setAuth(harnessId, {
				authenticated: false,
				canReauth: true,
				label: '',
				loading: false,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	async function checkReadiness(): Promise<void> {
		try {
			readinessByHarness = await getHarnessReadiness();
		} catch {
			readinessByHarness = {};
		}
	}

	function stopAuthPolling(harnessId: HarnessId): void {
		const timer = authPollTimers[harnessId];
		if (timer) clearTimeout(timer);
		delete authPollTimers[harnessId];
		delete authPollSessionIds[harnessId];
		delete authPollStartedAt[harnessId];
	}

	async function pollAuthUntilAuthenticated(harnessId: HarnessId, sessionId: number): Promise<void> {
		if (authPollSessionIds[harnessId] !== sessionId) return;

		await checkAuth(harnessId);
		if (authPollSessionIds[harnessId] !== sessionId) return;

		if (authFor(harnessId).authenticated) {
			stopAuthPolling(harnessId);
			clearDeviceAuth(harnessId);
			return;
		}

		const startedAt = authPollStartedAt[harnessId];
		if (startedAt === undefined) return;
		if (Date.now() - startedAt >= AUTH_POLL_TIMEOUT_MS) {
			stopAuthPolling(harnessId);
			return;
		}

		authPollTimers[harnessId] = setTimeout(() => {
			void pollAuthUntilAuthenticated(harnessId, sessionId);
		}, AUTH_POLL_INTERVAL_MS);
	}

	function startAuthPolling(harnessId: HarnessId): void {
		stopAuthPolling(harnessId);
		const sessionId = ++nextAuthPollSessionId;
		authPollSessionIds[harnessId] = sessionId;
		authPollStartedAt[harnessId] = Date.now();
		authPollTimers[harnessId] = setTimeout(() => {
			void pollAuthUntilAuthenticated(harnessId, sessionId);
		}, AUTH_POLL_INTERVAL_MS);
	}

	function clearDeviceAuth(harnessId: HarnessId): void {
		deviceAuthInfo = { ...deviceAuthInfo, [harnessId]: undefined };
		loginPending = { ...loginPending, [harnessId]: false };
	}

	async function handleLogin(harnessId: BrowserLoginHarnessId): Promise<void> {
		setAuth(harnessId, { ...authFor(harnessId), error: null });
		loginPending = { ...loginPending, [harnessId]: true };

		try {
			const result = await launchHarnessAuthLogin(harnessId);
			if (result.deviceAuth) {
				deviceAuthInfo = { ...deviceAuthInfo, [harnessId]: result.deviceAuth };
				loginPending = { ...loginPending, [harnessId]: false };
				window.open(result.deviceAuth.url, '_blank', 'noopener');
				startAuthPolling(harnessId);
				return;
			}

			await checkAuth(harnessId);
			loginPending = { ...loginPending, [harnessId]: false };
			if (!authFor(harnessId).authenticated) {
				startAuthPolling(harnessId);
			}
		} catch (err) {
			stopAuthPolling(harnessId);
			clearDeviceAuth(harnessId);
			setAuth(harnessId, {
				...authFor(harnessId),
				loading: false,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	onMount(() => {
		void modelCatalog.forceRefresh();
		for (const harnessId of harnessIds) {
			void checkAuth(harnessId);
		}
		void checkReadiness();

		return () => {
			for (const harnessId of harnessIds) {
				stopAuthPolling(harnessId);
			}
		};
	});
</script>

<section data-section="api-providers" class="space-y-8">
	<ApiProviderProtocolPanel
		protocol="anthropic-messages"
		title={m.settings_api_providers_anthropic_title()}
		description={m.settings_api_providers_anthropic_description()}
		addLabel={m.settings_api_providers_add_anthropic_provider()}
		oauthHarness={{ id: 'claude', name: nativeSourceLabelFor('claude') }}
		auth={authFor('claude')}
		readiness={readinessByHarness.claude}
		deviceAuth={deviceAuthInfo.claude}
		pending={loginPending.claude ?? false}
		onLogin={() => void handleLogin('claude')}
	/>

	<ApiProviderProtocolPanel
		protocol="openai-compatible"
		title={m.settings_api_providers_openai_title()}
		description={m.settings_api_providers_openai_description()}
		addLabel={m.settings_api_providers_add_openai_provider()}
		oauthHarness={{ id: 'codex', name: nativeSourceLabelFor('codex') }}
		auth={authFor('codex')}
		readiness={readinessByHarness.codex}
		deviceAuth={deviceAuthInfo.codex}
		pending={loginPending.codex ?? false}
		onLogin={() => void handleLogin('codex')}
	/>

	<OtherHarnessesSection {authByHarness} {readinessByHarness} />
</section>
