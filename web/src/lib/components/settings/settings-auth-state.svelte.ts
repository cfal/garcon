import {
	completeAgentAuthLogin,
	getAgentAuthLoginStatus,
	getAgentAuthStatus,
	getAgentReadiness,
	launchAgentAuthLogin,
	type DeviceAuthInfo,
	type AgentReadiness,
} from '$lib/api/agents.js';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte.js';

export interface AuthStatus {
	authenticated: boolean;
	canReauth: boolean;
	label: string;
	loading: boolean;
	error: string | null;
}

export type SettingsAgentId = string;

const AUTH_POLL_INTERVAL_MS = 1500;
const AUTH_POLL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_AUTH: AuthStatus = {
	authenticated: false,
	canReauth: true,
	label: '',
	loading: true,
	error: null,
};

export class SettingsAuthState {
	readonly #modelCatalog: ModelCatalogStore;
	#authPollTimers: Partial<Record<SettingsAgentId, ReturnType<typeof setTimeout>>> = {};
	#authPollRunIds: Partial<Record<SettingsAgentId, number>> = {};
	#authPollStartedAt: Partial<Record<SettingsAgentId, number>> = {};
	#loginSessionIds: Partial<Record<SettingsAgentId, string>> = {};
	#loginOperationGenerations: Partial<Record<SettingsAgentId, number>> = {};
	#authRequestGenerations: Partial<Record<SettingsAgentId, number>> = {};
	#nextAuthPollRunId = 0;
	#lifecycleId = 0;
	#active = true;

	authByAgent = $state<Record<string, AuthStatus>>({});
	readinessByAgent = $state<Record<string, AgentReadiness>>({});
	deviceAuthInfo = $state<Partial<Record<SettingsAgentId, DeviceAuthInfo>>>({});
	loginPending = $state<Partial<Record<SettingsAgentId, boolean>>>({});

	constructor(modelCatalog: ModelCatalogStore) {
		this.#modelCatalog = modelCatalog;
	}

	initialize(): () => void {
		this.#active = true;
		const lifecycleId = ++this.#lifecycleId;
		void this.#modelCatalog.forceRefresh();
		for (const agentId of this.#agentIds()) {
			void this.#checkAuth(agentId, lifecycleId);
			if (this.supportsAuthLogin(agentId)) {
				void this.#restoreLoginSession(agentId, lifecycleId);
			}
		}
		void this.#checkReadiness(lifecycleId);

		return () => {
			if (this.#lifecycleId === lifecycleId) this.destroy();
		};
	}

	destroy(): void {
		this.#active = false;
		this.#lifecycleId += 1;
		for (const agentId of Object.keys(this.#authPollTimers)) {
			this.#stopAuthPolling(agentId);
		}
		this.#loginSessionIds = {};
		this.#loginOperationGenerations = {};
		this.#authRequestGenerations = {};
		this.deviceAuthInfo = {};
		this.loginPending = {};
	}

	authFor(agentId: SettingsAgentId): AuthStatus {
		return this.authByAgent[agentId] ?? { ...DEFAULT_AUTH };
	}

	readinessFor(agentId: SettingsAgentId): AgentReadiness | undefined {
		return this.readinessByAgent[agentId];
	}

	deviceAuthFor(agentId: SettingsAgentId): DeviceAuthInfo | undefined {
		return this.deviceAuthInfo[agentId];
	}

	isLoginPending(agentId: SettingsAgentId): boolean {
		return this.loginPending[agentId] ?? false;
	}

	async handleLogin(agentId: SettingsAgentId): Promise<void> {
		if (!this.#active || !this.supportsAuthLogin(agentId)) return;
		const lifecycleId = this.#lifecycleId;
		const operationGeneration = this.#beginLoginOperation(agentId);
		this.#setAuth(agentId, { ...this.authFor(agentId), error: null });
		this.loginPending = { ...this.loginPending, [agentId]: true };

		try {
			const result = await launchAgentAuthLogin(agentId);
			if (!this.#isCurrentLoginOperation(agentId, operationGeneration, lifecycleId)) return;
			this.#loginSessionIds[agentId] = result.sessionId;
			if (result.deviceAuth) {
				this.deviceAuthInfo = { ...this.deviceAuthInfo, [agentId]: result.deviceAuth };
				if (!result.deviceAuth.needsCode) {
					window.open(result.deviceAuth.url, '_blank', 'noopener');
				}
			}
			this.loginPending = { ...this.loginPending, [agentId]: false };
			this.#startLoginSessionPolling(agentId, result.sessionId, operationGeneration, lifecycleId);
		} catch (err) {
			if (!this.#isCurrentLoginOperation(agentId, operationGeneration, lifecycleId)) return;
			this.#stopAuthPolling(agentId);
			this.#clearLoginState(agentId);
			this.#setAuth(agentId, {
				...this.authFor(agentId),
				loading: false,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			if (this.#isCurrentLoginOperation(agentId, operationGeneration, lifecycleId)) {
				this.loginPending = { ...this.loginPending, [agentId]: false };
			}
		}
	}

	async completeLogin(agentId: SettingsAgentId, code: string): Promise<void> {
		if (!this.#active || !this.supportsAuthLogin(agentId)) return;
		const lifecycleId = this.#lifecycleId;
		const sessionId = this.#loginSessionIds[agentId];
		if (!sessionId) return;
		const operationGeneration = this.#beginLoginOperation(agentId);
		this.#setAuth(agentId, { ...this.authFor(agentId), error: null });
		this.loginPending = { ...this.loginPending, [agentId]: true };

		try {
			await completeAgentAuthLogin(agentId, sessionId, code);
			if (!this.#ownsSession(agentId, sessionId, operationGeneration, lifecycleId)) return;
			this.#startLoginSessionPolling(agentId, sessionId, operationGeneration, lifecycleId);
		} catch (err) {
			if (!this.#ownsSession(agentId, sessionId, operationGeneration, lifecycleId)) return;
			this.loginPending = { ...this.loginPending, [agentId]: false };
			this.#setAuth(agentId, {
				...this.authFor(agentId),
				loading: false,
				error: err instanceof Error ? err.message : String(err),
			});
			this.#startLoginSessionPolling(agentId, sessionId, operationGeneration, lifecycleId);
		}
	}

	#setAuth(agentId: SettingsAgentId, auth: AuthStatus): void {
		this.authByAgent = { ...this.authByAgent, [agentId]: auth };
	}

	async #checkAuth(
		agentId: SettingsAgentId,
		lifecycleId = this.#lifecycleId,
		operationGeneration?: number,
	): Promise<boolean | undefined> {
		const authRequestGeneration = this.#beginAuthRequest(agentId);
		try {
			const data = await getAgentAuthStatus(agentId);
			if (
				!this.#canApplyAgentResult(agentId, lifecycleId, operationGeneration, authRequestGeneration)
			)
				return undefined;
			this.#setAuth(agentId, {
				authenticated: data.authenticated,
				canReauth: data.canReauth,
				label: data.label,
				loading: false,
				error: null,
			});
			return data.authenticated;
		} catch (err) {
			if (
				!this.#canApplyAgentResult(agentId, lifecycleId, operationGeneration, authRequestGeneration)
			)
				return undefined;
			this.#setAuth(agentId, {
				authenticated: false,
				canReauth: true,
				label: '',
				loading: false,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	async #checkReadiness(lifecycleId: number): Promise<void> {
		try {
			const readiness = await getAgentReadiness();
			if (this.#isActive(lifecycleId)) this.readinessByAgent = readiness;
		} catch {
			if (this.#isActive(lifecycleId)) this.readinessByAgent = {};
		}
	}

	#stopAuthPolling(agentId: SettingsAgentId): void {
		const timer = this.#authPollTimers[agentId];
		if (timer) clearTimeout(timer);
		delete this.#authPollTimers[agentId];
		delete this.#authPollRunIds[agentId];
		delete this.#authPollStartedAt[agentId];
	}

	async #pollAuthUntilAuthenticated(
		agentId: SettingsAgentId,
		pollRunId: number,
		operationGeneration: number,
		lifecycleId: number,
	): Promise<void> {
		if (!this.#isCurrentPoll(agentId, pollRunId, operationGeneration, lifecycleId)) return;

		await this.#checkAuth(agentId, lifecycleId, operationGeneration);
		if (!this.#isCurrentPoll(agentId, pollRunId, operationGeneration, lifecycleId)) return;

		if (this.authFor(agentId).authenticated) {
			this.#stopAuthPolling(agentId);
			this.#clearLoginState(agentId);
			return;
		}

		const startedAt = this.#authPollStartedAt[agentId];
		if (startedAt === undefined) return;
		if (Date.now() - startedAt >= AUTH_POLL_TIMEOUT_MS) {
			this.#stopAuthPolling(agentId);
			return;
		}

		this.#authPollTimers[agentId] = setTimeout(() => {
			void this.#pollAuthUntilAuthenticated(agentId, pollRunId, operationGeneration, lifecycleId);
		}, AUTH_POLL_INTERVAL_MS);
	}

	#startAuthPolling(
		agentId: SettingsAgentId,
		operationGeneration: number,
		lifecycleId: number,
	): void {
		this.#stopAuthPolling(agentId);
		const pollRunId = ++this.#nextAuthPollRunId;
		this.#authPollRunIds[agentId] = pollRunId;
		this.#authPollStartedAt[agentId] = Date.now();
		this.#authPollTimers[agentId] = setTimeout(() => {
			void this.#pollAuthUntilAuthenticated(agentId, pollRunId, operationGeneration, lifecycleId);
		}, AUTH_POLL_INTERVAL_MS);
	}

	// Polls the server-side login session while a device code is displayed.
	// Auth status cannot signal completion here: agents with existing
	// credentials report authenticated during the whole re-login, which would
	// clear the code before the user can enter it.
	async #pollLoginSessionUntilDone(
		agentId: SettingsAgentId,
		sessionId: string,
		pollRunId: number,
		operationGeneration: number,
		lifecycleId: number,
	): Promise<void> {
		if (!this.#isCurrentPoll(agentId, pollRunId, operationGeneration, lifecycleId)) return;

		let status: Awaited<ReturnType<typeof getAgentAuthLoginStatus>> | undefined;
		try {
			status = await getAgentAuthLoginStatus(agentId, sessionId);
		} catch {
			// The server watchdog owns expiry, so transient request failures retain session ownership.
		}
		if (!this.#isCurrentPoll(agentId, pollRunId, operationGeneration, lifecycleId)) return;

		if (status?.state === 'running' && status.sessionId === sessionId) {
			if (status.deviceAuth) {
				this.deviceAuthInfo = { ...this.deviceAuthInfo, [agentId]: status.deviceAuth };
			}
		} else if (status?.state === 'succeeded' && status.sessionId === sessionId) {
			this.#stopAuthPolling(agentId);
			this.#clearLoginState(agentId);
			const authenticated = await this.#checkAuth(agentId, lifecycleId, operationGeneration);
			if (
				authenticated === false &&
				this.#isCurrentLoginOperation(agentId, operationGeneration, lifecycleId)
			) {
				this.#startAuthPolling(agentId, operationGeneration, lifecycleId);
			}
			return;
		} else if (status?.state === 'failed' && status.sessionId === sessionId) {
			this.#stopAuthPolling(agentId);
			this.#clearLoginState(agentId);
			this.#setAuth(agentId, {
				...this.authFor(agentId),
				loading: false,
				error: status.error,
			});
			return;
		}

		this.#authPollTimers[agentId] = setTimeout(() => {
			void this.#pollLoginSessionUntilDone(
				agentId,
				sessionId,
				pollRunId,
				operationGeneration,
				lifecycleId,
			);
		}, AUTH_POLL_INTERVAL_MS);
	}

	#startLoginSessionPolling(
		agentId: SettingsAgentId,
		sessionId: string,
		operationGeneration: number,
		lifecycleId: number,
	): void {
		this.#stopAuthPolling(agentId);
		const pollRunId = ++this.#nextAuthPollRunId;
		this.#authPollRunIds[agentId] = pollRunId;
		this.#authPollStartedAt[agentId] = Date.now();
		void this.#pollLoginSessionUntilDone(
			agentId,
			sessionId,
			pollRunId,
			operationGeneration,
			lifecycleId,
		);
	}

	async #restoreLoginSession(agentId: SettingsAgentId, lifecycleId: number): Promise<void> {
		const operationGeneration = this.#beginLoginOperation(agentId, false);
		try {
			const status = await getAgentAuthLoginStatus(agentId);
			if (
				!this.#isCurrentLoginOperation(agentId, operationGeneration, lifecycleId) ||
				status.state !== 'running'
			) {
				return;
			}
			this.#loginSessionIds[agentId] = status.sessionId;
			if (status.deviceAuth) {
				this.deviceAuthInfo = { ...this.deviceAuthInfo, [agentId]: status.deviceAuth };
			}
			this.#startLoginSessionPolling(agentId, status.sessionId, operationGeneration, lifecycleId);
		} catch {
			// Auth status remains usable when login-session restoration is temporarily unavailable.
		}
	}

	#clearLoginState(agentId: SettingsAgentId): void {
		delete this.#loginSessionIds[agentId];
		this.deviceAuthInfo = { ...this.deviceAuthInfo, [agentId]: undefined };
		this.loginPending = { ...this.loginPending, [agentId]: false };
	}

	#isActive(lifecycleId: number): boolean {
		return this.#active && this.#lifecycleId === lifecycleId;
	}

	#beginLoginOperation(agentId: SettingsAgentId, invalidateAuthRequest = true): number {
		this.#stopAuthPolling(agentId);
		if (invalidateAuthRequest) this.#beginAuthRequest(agentId);
		const generation = (this.#loginOperationGenerations[agentId] ?? 0) + 1;
		this.#loginOperationGenerations[agentId] = generation;
		return generation;
	}

	#canApplyAgentResult(
		agentId: SettingsAgentId,
		lifecycleId: number,
		operationGeneration?: number,
		authRequestGeneration?: number,
	): boolean {
		return (
			this.#isActive(lifecycleId) &&
			(operationGeneration === undefined ||
				this.#loginOperationGenerations[agentId] === operationGeneration) &&
			(authRequestGeneration === undefined ||
				this.#authRequestGenerations[agentId] === authRequestGeneration)
		);
	}

	#beginAuthRequest(agentId: SettingsAgentId): number {
		const generation = (this.#authRequestGenerations[agentId] ?? 0) + 1;
		this.#authRequestGenerations[agentId] = generation;
		return generation;
	}

	#isCurrentLoginOperation(
		agentId: SettingsAgentId,
		operationGeneration: number,
		lifecycleId: number,
	): boolean {
		return this.#canApplyAgentResult(agentId, lifecycleId, operationGeneration);
	}

	#ownsSession(
		agentId: SettingsAgentId,
		sessionId: string,
		operationGeneration: number,
		lifecycleId: number,
	): boolean {
		return (
			this.#isCurrentLoginOperation(agentId, operationGeneration, lifecycleId) &&
			this.#loginSessionIds[agentId] === sessionId
		);
	}

	#isCurrentPoll(
		agentId: SettingsAgentId,
		pollRunId: number,
		operationGeneration: number,
		lifecycleId: number,
	): boolean {
		return (
			this.#isCurrentLoginOperation(agentId, operationGeneration, lifecycleId) &&
			this.#authPollRunIds[agentId] === pollRunId
		);
	}

	supportsAuthLogin(agentId: SettingsAgentId): boolean {
		return this.#modelCatalog.getAgent(agentId)?.authLoginSupported === true;
	}

	#agentIds(): SettingsAgentId[] {
		const catalog = this.#modelCatalog as unknown as {
			getAgentMetadataList?: () => Array<{ id: string }>;
			getAgents?: () => string[];
		};
		if (typeof catalog.getAgentMetadataList === 'function') {
			return catalog.getAgentMetadataList().map((metadata) => metadata.id);
		}
		if (typeof catalog.getAgents === 'function') {
			return catalog.getAgents();
		}
		return [];
	}
}
