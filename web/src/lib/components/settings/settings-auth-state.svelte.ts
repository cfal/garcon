import {
	getHarnessAuthStatus,
	getHarnessReadiness,
	launchHarnessAuthLogin,
	type DeviceAuthInfo,
	type HarnessReadiness
} from '$lib/api/providers.js';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte.js';

export interface AuthStatus {
	authenticated: boolean;
	canReauth: boolean;
	label: string;
	loading: boolean;
	error: string | null;
}

export type SettingsHarnessId = 'claude' | 'codex' | 'opencode' | 'amp' | 'cursor' | 'factory' | 'pi';
export type BrowserLoginHarnessId = 'claude' | 'codex';

const AUTH_POLL_INTERVAL_MS = 1500;
const AUTH_POLL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_AUTH: AuthStatus = {
	authenticated: false,
	canReauth: true,
	label: '',
	loading: true,
	error: null
};
const HARNESS_IDS: SettingsHarnessId[] = ['claude', 'codex', 'opencode', 'amp', 'cursor', 'factory', 'pi'];

export class SettingsAuthState {
	readonly #modelCatalog: ModelCatalogStore;
	#authPollTimers: Partial<Record<SettingsHarnessId, ReturnType<typeof setTimeout>>> = {};
	#authPollSessionIds: Partial<Record<SettingsHarnessId, number>> = {};
	#authPollStartedAt: Partial<Record<SettingsHarnessId, number>> = {};
	#nextAuthPollSessionId = 0;

	authByHarness = $state<Record<string, AuthStatus>>({});
	readinessByHarness = $state<Record<string, HarnessReadiness>>({});
	deviceAuthInfo = $state<Partial<Record<SettingsHarnessId, DeviceAuthInfo>>>({});
	loginPending = $state<Partial<Record<SettingsHarnessId, boolean>>>({});

	constructor(modelCatalog: ModelCatalogStore) {
		this.#modelCatalog = modelCatalog;
	}

	initialize(): () => void {
		void this.#modelCatalog.forceRefresh();
		for (const harnessId of HARNESS_IDS) {
			void this.#checkAuth(harnessId);
		}
		void this.#checkReadiness();

		return () => {
			this.destroy();
		};
	}

	destroy(): void {
		for (const harnessId of HARNESS_IDS) {
			this.#stopAuthPolling(harnessId);
		}
	}

	authFor(harnessId: SettingsHarnessId): AuthStatus {
		return this.authByHarness[harnessId] ?? { ...DEFAULT_AUTH };
	}

	readinessFor(harnessId: SettingsHarnessId): HarnessReadiness | undefined {
		return this.readinessByHarness[harnessId];
	}

	deviceAuthFor(harnessId: SettingsHarnessId): DeviceAuthInfo | undefined {
		return this.deviceAuthInfo[harnessId];
	}

	isLoginPending(harnessId: SettingsHarnessId): boolean {
		return this.loginPending[harnessId] ?? false;
	}

	async handleLogin(harnessId: BrowserLoginHarnessId): Promise<void> {
		this.#setAuth(harnessId, { ...this.authFor(harnessId), error: null });
		this.loginPending = { ...this.loginPending, [harnessId]: true };

		try {
			const result = await launchHarnessAuthLogin(harnessId);
			if (result.deviceAuth) {
				this.deviceAuthInfo = { ...this.deviceAuthInfo, [harnessId]: result.deviceAuth };
				this.loginPending = { ...this.loginPending, [harnessId]: false };
				window.open(result.deviceAuth.url, '_blank', 'noopener');
				this.#startAuthPolling(harnessId);
				return;
			}

			await this.#checkAuth(harnessId);
			this.loginPending = { ...this.loginPending, [harnessId]: false };
			if (!this.authFor(harnessId).authenticated) {
				this.#startAuthPolling(harnessId);
			}
		} catch (err) {
			this.#stopAuthPolling(harnessId);
			this.#clearDeviceAuth(harnessId);
			this.#setAuth(harnessId, {
				...this.authFor(harnessId),
				loading: false,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	#setAuth(harnessId: SettingsHarnessId, auth: AuthStatus): void {
		this.authByHarness = { ...this.authByHarness, [harnessId]: auth };
	}

	async #checkAuth(harnessId: SettingsHarnessId): Promise<void> {
		try {
			const data = await getHarnessAuthStatus(harnessId);
			this.#setAuth(harnessId, {
				authenticated: data.authenticated,
				canReauth: data.canReauth,
				label: data.label,
				loading: false,
				error: null
			});
		} catch (err) {
			this.#setAuth(harnessId, {
				authenticated: false,
				canReauth: true,
				label: '',
				loading: false,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	async #checkReadiness(): Promise<void> {
		try {
			this.readinessByHarness = await getHarnessReadiness();
		} catch {
			this.readinessByHarness = {};
		}
	}

	#stopAuthPolling(harnessId: SettingsHarnessId): void {
		const timer = this.#authPollTimers[harnessId];
		if (timer) clearTimeout(timer);
		delete this.#authPollTimers[harnessId];
		delete this.#authPollSessionIds[harnessId];
		delete this.#authPollStartedAt[harnessId];
	}

	async #pollAuthUntilAuthenticated(harnessId: SettingsHarnessId, sessionId: number): Promise<void> {
		if (this.#authPollSessionIds[harnessId] !== sessionId) return;

		await this.#checkAuth(harnessId);
		if (this.#authPollSessionIds[harnessId] !== sessionId) return;

		if (this.authFor(harnessId).authenticated) {
			this.#stopAuthPolling(harnessId);
			this.#clearDeviceAuth(harnessId);
			return;
		}

		const startedAt = this.#authPollStartedAt[harnessId];
		if (startedAt === undefined) return;
		if (Date.now() - startedAt >= AUTH_POLL_TIMEOUT_MS) {
			this.#stopAuthPolling(harnessId);
			return;
		}

		this.#authPollTimers[harnessId] = setTimeout(() => {
			void this.#pollAuthUntilAuthenticated(harnessId, sessionId);
		}, AUTH_POLL_INTERVAL_MS);
	}

	#startAuthPolling(harnessId: SettingsHarnessId): void {
		this.#stopAuthPolling(harnessId);
		const sessionId = ++this.#nextAuthPollSessionId;
		this.#authPollSessionIds[harnessId] = sessionId;
		this.#authPollStartedAt[harnessId] = Date.now();
		this.#authPollTimers[harnessId] = setTimeout(() => {
			void this.#pollAuthUntilAuthenticated(harnessId, sessionId);
		}, AUTH_POLL_INTERVAL_MS);
	}

	#clearDeviceAuth(harnessId: SettingsHarnessId): void {
		this.deviceAuthInfo = { ...this.deviceAuthInfo, [harnessId]: undefined };
		this.loginPending = { ...this.loginPending, [harnessId]: false };
	}
}
