import {
	completeAgentAuthLogin,
	getAgentAuthLoginStatus,
	getAgentAuthStatus,
	getAgentReadiness,
	launchAgentAuthLogin,
	type DeviceAuthInfo,
	type AgentReadiness,
	type AgentAuthStatus,
	type AgentAuthLoginStatus,
} from '$lib/api/agents.js';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';

export interface AuthStatus extends Pick<AgentAuthStatus, 'authenticated' | 'canReauth' | 'label' | 'detail'> {
	loading: boolean;
	error: string | null;
}

export type SettingsAgentId = string;

interface LoginObservation {
	sessionId?: string;
	detach?: () => void;
}

const DEFAULT_AUTH: AuthStatus = {
	authenticated: false,
	canReauth: true,
	label: '',
	loading: true,
	error: null,
};

export class SettingsAuthState {
	readonly #modelCatalog: ModelCatalogStore;
	readonly #logins = new Map<SettingsAgentId, LoginObservation>();
	#authRequestGenerations: Partial<Record<SettingsAgentId, number>> = {};
	#lifecycleId = 0;
	#active = true;

	#authByAgent = $state<Record<string, AuthStatus>>({});
	#readinessByAgent = $state<Record<string, AgentReadiness>>({});
	#deviceAuthInfo = $state<Partial<Record<SettingsAgentId, DeviceAuthInfo>>>({});
	#loginPending = $state<Partial<Record<SettingsAgentId, boolean>>>({});

	constructor(modelCatalog: ModelCatalogStore) {
		this.#modelCatalog = modelCatalog;
	}

	get executorId(): string { return this.#modelCatalog.executorId; }

	initialize(): () => void {
		this.#active = true;
		const lifecycleId = ++this.#lifecycleId;
		const checkAgent = (agentId: SettingsAgentId) => {
			void this.#checkAuth(agentId, lifecycleId);
			if (this.supportsAuthLogin(agentId)) void this.#restoreLoginSession(agentId, lifecycleId);
		};
		void this.#modelCatalog.forceRefresh().then(() => {
			if (!this.#isActive(lifecycleId)) return;
			for (const agentId of this.#agentIds()) {
				if (!this.#authRequestGenerations[agentId]) checkAgent(agentId);
			}
		});
		for (const agentId of this.#agentIds()) checkAgent(agentId);
		void this.#checkReadiness(lifecycleId);

		return () => {
			if (this.#lifecycleId === lifecycleId) this.destroy();
		};
	}

	destroy(): void {
		this.#active = false;
		this.#lifecycleId += 1;
		for (const login of this.#logins.values()) login.detach?.();
		this.#logins.clear();
		this.#authRequestGenerations = {};
		this.#deviceAuthInfo = {};
		this.#loginPending = {};
		this.#authByAgent = {};
		this.#readinessByAgent = {};
	}

	authFor(agentId: SettingsAgentId): AuthStatus {
		return this.#authByAgent[agentId] ?? { ...DEFAULT_AUTH };
	}

	readinessFor(agentId: SettingsAgentId): AgentReadiness | undefined {
		return this.#readinessByAgent[agentId];
	}

	deviceAuthFor(agentId: SettingsAgentId): DeviceAuthInfo | undefined {
		return this.#deviceAuthInfo[agentId];
	}

	isLoginPending(agentId: SettingsAgentId): boolean {
		return this.#loginPending[agentId] ?? false;
	}

	async handleLogin(agentId: SettingsAgentId): Promise<void> {
		if (!this.#active || !this.supportsAuthLogin(agentId)) return;
		const lifecycleId = this.#lifecycleId;
		const login = this.#beginLoginOperation(agentId);
		this.#markLoginPending(agentId);

		const lifetime = this.#modelCatalog.pendingLogins.lifetime;
		const retire = () => {
			if (this.#isCurrentLogin(agentId, login, lifecycleId)) this.#clearLoginState(agentId, login);
		};
		lifetime.addEventListener('abort', retire, { once: true });
		try {
			const result = await launchAgentAuthLogin(agentId, this.executorId);
			if (lifetime.aborted || !this.#isCurrentLogin(agentId, login, lifecycleId)) return;
			login.sessionId = result.sessionId;
			if (result.deviceAuth) {
				this.#deviceAuthInfo[agentId] = result.deviceAuth;
				if (!result.deviceAuth.needsCode) {
					window.open(result.deviceAuth.url, '_blank', 'noopener');
				}
			}
			this.#loginPending[agentId] = result.alreadyRunning;
			this.#observeLogin(agentId, result.sessionId, login, lifecycleId);
		} catch (err) {
			if (lifetime.aborted || !this.#isCurrentLogin(agentId, login, lifecycleId)) return;
			this.#clearLoginState(agentId, login);
			this.#setLoginError(agentId, err);
		} finally {
			lifetime.removeEventListener('abort', retire);
		}
	}

	async completeLogin(agentId: SettingsAgentId, code: string): Promise<void> {
		if (!this.#active || !this.supportsAuthLogin(agentId) || this.isLoginPending(agentId) || !code.trim()) return;
		const lifecycleId = this.#lifecycleId;
		const login = this.#logins.get(agentId);
		const sessionId = login?.sessionId;
		if (!login || !sessionId) return;
		const resumePolling = this.#modelCatalog.pendingLogins.beginSubmission(agentId, sessionId);
		if (!resumePolling) return;
		this.#markLoginPending(agentId);

		try {
			await completeAgentAuthLogin(agentId, sessionId, code, this.executorId);
		} catch (err) {
			if (!this.#isCurrentLogin(agentId, login, lifecycleId) || login.sessionId !== sessionId) return;
			this.#setLoginError(agentId, err);
		} finally {
			resumePolling();
		}
	}

	#markLoginPending(agentId: SettingsAgentId): void {
		this.#beginAuthRequest(agentId);
		this.#authByAgent[agentId] = { ...this.authFor(agentId), error: null };
		this.#loginPending[agentId] = true;
	}

	#setLoginError(agentId: SettingsAgentId, err: unknown): void {
		this.#authByAgent[agentId] = {
			...this.authFor(agentId),
			loading: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	async #checkAuth(agentId: SettingsAgentId, lifecycleId: number): Promise<void> {
		const authRequestGeneration = this.#beginAuthRequest(agentId);
		const current = () => this.#isActive(lifecycleId) && this.#authRequestGenerations[agentId] === authRequestGeneration;
		try {
			const data = await getAgentAuthStatus(agentId, this.executorId);
			if (!current()) return;
			this.#authByAgent[agentId] = {
				...data,
				loading: false,
				error: this.#logins.get(agentId)?.sessionId ? this.authFor(agentId).error : null,
			};
		} catch (err) {
			if (!current()) return;
			this.#authByAgent[agentId] = {
				...DEFAULT_AUTH,
				loading: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async #checkReadiness(lifecycleId: number): Promise<void> {
		try {
			const readiness = await getAgentReadiness(this.executorId);
			if (this.#isActive(lifecycleId)) this.#readinessByAgent = readiness;
		} catch {
			if (this.#isActive(lifecycleId)) this.#readinessByAgent = {};
		}
	}

	#observeLogin(agentId: string, sessionId: string, login: LoginObservation, lifecycleId: number): void {
		login.detach = this.#modelCatalog.pendingLogins.observe(agentId, sessionId, (event) => {
			if (!this.#isCurrentLogin(agentId, login, lifecycleId)) return;
			if (event.state === 'running') {
				this.#applyRunningLoginStatus(agentId, event);
				return;
			}
			this.#clearLoginState(agentId, login);
			this.#beginAuthRequest(agentId);
			if (event.state === 'credentials') {
				this.#authByAgent[agentId] = { ...event.auth, loading: false, error: null };
			} else if (event.state === 'credential-error') {
				this.#authByAgent[agentId] = { ...DEFAULT_AUTH, loading: false, error: event.error };
			} else if (event.state === 'failed') {
				this.#setLoginError(agentId, event.error);
			}
		});
	}

	async #restoreLoginSession(agentId: SettingsAgentId, lifecycleId: number): Promise<void> {
		const login = this.#beginLoginOperation(agentId);
		const observedSession = this.#modelCatalog.pendingLogins.sessionId(agentId);
		if (observedSession) {
			login.sessionId = observedSession;
			this.#loginPending[agentId] = true;
			this.#observeLogin(agentId, observedSession, login, lifecycleId);
			return;
		}
		const lifetime = this.#modelCatalog.pendingLogins.lifetime;
		try {
			const status = await getAgentAuthLoginStatus(agentId, undefined, this.executorId);
			if (
				lifetime.aborted || !this.#isCurrentLogin(agentId, login, lifecycleId) ||
				status.state !== 'running'
			) {
				return;
			}
			login.sessionId = status.sessionId;
			this.#applyRunningLoginStatus(agentId, status);
			this.#observeLogin(agentId, status.sessionId, login, lifecycleId);
		} catch {
			// Auth status remains usable when login-session restoration is temporarily unavailable.
		}
	}

	#applyRunningLoginStatus(
		agentId: SettingsAgentId,
		status: Extract<AgentAuthLoginStatus, { state: 'running' }>,
	): void {
		this.#loginPending[agentId] = status.completionPending;
		if (status.deviceAuth) {
			this.#deviceAuthInfo[agentId] = status.deviceAuth;
		}
		if (status.retryableError) {
			this.#authByAgent[agentId] = { ...this.authFor(agentId), error: status.retryableError };
		}
	}

	#clearLoginState(agentId: SettingsAgentId, login: LoginObservation): void {
		delete login.sessionId;
		delete this.#deviceAuthInfo[agentId];
		this.#loginPending[agentId] = false;
	}

	#isActive(lifecycleId: number): boolean {
		return this.#active && this.#lifecycleId === lifecycleId;
	}

	#beginLoginOperation(agentId: SettingsAgentId): LoginObservation {
		const previous = this.#logins.get(agentId);
		previous?.detach?.();
		const login = { sessionId: previous?.sessionId };
		this.#logins.set(agentId, login);
		return login;
	}

	#beginAuthRequest(agentId: SettingsAgentId): number {
		const generation = (this.#authRequestGenerations[agentId] ?? 0) + 1;
		this.#authRequestGenerations[agentId] = generation;
		return generation;
	}

	#isCurrentLogin(agentId: SettingsAgentId, login: LoginObservation, lifecycleId: number): boolean {
		return this.#isActive(lifecycleId) && this.#logins.get(agentId) === login;
	}

	supportsAuthLogin(agentId: SettingsAgentId): boolean {
		return this.#modelCatalog.getAgent(agentId)?.authLoginSupported === true;
	}

	#agentIds(): SettingsAgentId[] {
		return this.#modelCatalog.getAgentMetadataList().map((metadata) => metadata.id);
	}
}
