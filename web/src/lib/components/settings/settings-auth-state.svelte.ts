import {
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
	#authPollSessionIds: Partial<Record<SettingsAgentId, number>> = {};
	#authPollStartedAt: Partial<Record<SettingsAgentId, number>> = {};
	#nextAuthPollSessionId = 0;

	authByAgent = $state<Record<string, AuthStatus>>({});
	readinessByAgent = $state<Record<string, AgentReadiness>>({});
	deviceAuthInfo = $state<Partial<Record<SettingsAgentId, DeviceAuthInfo>>>({});
	loginPending = $state<Partial<Record<SettingsAgentId, boolean>>>({});

	constructor(modelCatalog: ModelCatalogStore) {
		this.#modelCatalog = modelCatalog;
	}

	initialize(): () => void {
		void this.#modelCatalog.forceRefresh();
		for (const agentId of this.#agentIds()) {
			void this.#checkAuth(agentId);
		}
		void this.#checkReadiness();

		return () => {
			this.destroy();
		};
	}

	destroy(): void {
		for (const agentId of this.#agentIds()) {
			this.#stopAuthPolling(agentId);
		}
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
		if (!this.supportsAuthLogin(agentId)) return;
		this.#setAuth(agentId, { ...this.authFor(agentId), error: null });
		this.loginPending = { ...this.loginPending, [agentId]: true };

		try {
			const result = await launchAgentAuthLogin(agentId);
			if (result.deviceAuth) {
				this.deviceAuthInfo = { ...this.deviceAuthInfo, [agentId]: result.deviceAuth };
				this.loginPending = { ...this.loginPending, [agentId]: false };
				window.open(result.deviceAuth.url, '_blank', 'noopener');
				this.#startAuthPolling(agentId);
				return;
			}

			await this.#checkAuth(agentId);
			this.loginPending = { ...this.loginPending, [agentId]: false };
			if (!this.authFor(agentId).authenticated) {
				this.#startAuthPolling(agentId);
			}
		} catch (err) {
			this.#stopAuthPolling(agentId);
			this.#clearDeviceAuth(agentId);
			this.#setAuth(agentId, {
				...this.authFor(agentId),
				loading: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	#setAuth(agentId: SettingsAgentId, auth: AuthStatus): void {
		this.authByAgent = { ...this.authByAgent, [agentId]: auth };
	}

	async #checkAuth(agentId: SettingsAgentId): Promise<void> {
		try {
			const data = await getAgentAuthStatus(agentId);
			this.#setAuth(agentId, {
				authenticated: data.authenticated,
				canReauth: data.canReauth,
				label: data.label,
				loading: false,
				error: null,
			});
		} catch (err) {
			this.#setAuth(agentId, {
				authenticated: false,
				canReauth: true,
				label: '',
				loading: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async #checkReadiness(): Promise<void> {
		try {
			this.readinessByAgent = await getAgentReadiness();
		} catch {
			this.readinessByAgent = {};
		}
	}

	#stopAuthPolling(agentId: SettingsAgentId): void {
		const timer = this.#authPollTimers[agentId];
		if (timer) clearTimeout(timer);
		delete this.#authPollTimers[agentId];
		delete this.#authPollSessionIds[agentId];
		delete this.#authPollStartedAt[agentId];
	}

	async #pollAuthUntilAuthenticated(agentId: SettingsAgentId, sessionId: number): Promise<void> {
		if (this.#authPollSessionIds[agentId] !== sessionId) return;

		await this.#checkAuth(agentId);
		if (this.#authPollSessionIds[agentId] !== sessionId) return;

		if (this.authFor(agentId).authenticated) {
			this.#stopAuthPolling(agentId);
			this.#clearDeviceAuth(agentId);
			return;
		}

		const startedAt = this.#authPollStartedAt[agentId];
		if (startedAt === undefined) return;
		if (Date.now() - startedAt >= AUTH_POLL_TIMEOUT_MS) {
			this.#stopAuthPolling(agentId);
			return;
		}

		this.#authPollTimers[agentId] = setTimeout(() => {
			void this.#pollAuthUntilAuthenticated(agentId, sessionId);
		}, AUTH_POLL_INTERVAL_MS);
	}

	#startAuthPolling(agentId: SettingsAgentId): void {
		this.#stopAuthPolling(agentId);
		const sessionId = ++this.#nextAuthPollSessionId;
		this.#authPollSessionIds[agentId] = sessionId;
		this.#authPollStartedAt[agentId] = Date.now();
		this.#authPollTimers[agentId] = setTimeout(() => {
			void this.#pollAuthUntilAuthenticated(agentId, sessionId);
		}, AUTH_POLL_INTERVAL_MS);
	}

	#clearDeviceAuth(agentId: SettingsAgentId): void {
		this.deviceAuthInfo = { ...this.deviceAuthInfo, [agentId]: undefined };
		this.loginPending = { ...this.loginPending, [agentId]: false };
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
