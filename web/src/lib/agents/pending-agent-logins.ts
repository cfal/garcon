import {
	getAgentAuthLoginStatus, getAgentAuthStatus, launchAgentAuthLogin, type AgentAuthLoginStatus, type AgentAuthStatus,
} from '$lib/api/agents.js';
import { ApiError } from '$lib/api/client.js';

type LoginEvent = Exclude<AgentAuthLoginStatus, { state: 'idle' }>
	| { state: 'launching' }
	| { state: 'cleared' }
	| { state: 'credentials'; auth: AgentAuthStatus }
	| { state: 'credential-error'; error: string }
	| { state: 'error'; error: string };
type Listener = (event: LoginEvent, source?: 'launch') => void;

interface PendingLogin {
	sessionId?: string;
	listener?: Listener;
	latest: LoginEvent;
	confirmingInstance?: string;
	submitting?: boolean;
	revision: number;
	timer?: ReturnType<typeof setTimeout>;
	expiry?: ReturnType<typeof setTimeout>;
}

const POLL_INTERVAL_MS = 1500;
// Allows the CLI's 15-minute watchdog to publish its own terminal status first.
const SESSION_TIMEOUT_MS = 16 * 60_000;
const CREDENTIAL_TIMEOUT_MS = 5 * 60_000;

/** Owns launch and session-qualified polling independently of the Settings view. */
export class PendingAgentLogins {
	#pending = new Map<string, PendingLogin>();

	constructor(private readonly executorId: string, private readonly onAuthenticated: (agentId: string, instanceId: string) => void) {}

	sessionId(agentId: string): string | undefined {
		return this.#pending.get(agentId)?.sessionId;
	}

	async launch(agentId: string): Promise<void> {
		this.#stop(agentId, { state: 'cleared' });
		const pending: PendingLogin = { revision: 0, latest: { state: 'launching' } };
		this.#pending.set(agentId, pending);
		this.#expireAfter(agentId, pending, SESSION_TIMEOUT_MS);
		try {
			const result = await launchAgentAuthLogin(agentId, this.executorId);
			if (this.#pending.get(agentId) !== pending) return;
			pending.sessionId = result.sessionId;
			pending.latest = { state: 'running', running: true, sessionId: result.sessionId,
				completionPending: result.alreadyRunning, deviceAuth: result.deviceAuth };
			pending.listener?.(pending.latest, 'launch');
			void this.#poll(agentId, pending);
		} catch (error) {
			if (this.#pending.get(agentId) !== pending) return;
			this.#stop(agentId, { state: 'error', error: error instanceof Error ? error.message : String(error) });
		}
	}

	attach(agentId: string, listener: Listener): (() => void) | undefined {
		const pending = this.#pending.get(agentId);
		if (!pending) return;
		pending.listener = listener;
		// Restores the form, but only a fresh status can authorize another submission.
		if (pending.latest.state === 'running') listener({ ...pending.latest, completionPending: true });
		else listener(pending.latest);
		return () => { if (pending.listener === listener) pending.listener = undefined; };
	}

	beginSubmission(agentId: string, sessionId: string): (() => void) | undefined {
		const pending = this.#pending.get(agentId);
		if (!pending || pending.sessionId !== sessionId || pending.submitting || pending.confirmingInstance) return;
		pending.submitting = true;
		clearTimeout(pending.timer);
		pending.revision++;
		if (pending.latest.state === 'running') {
			pending.latest = { ...pending.latest, completionPending: true, retryableError: undefined };
		}
		return () => {
			if (this.#pending.get(agentId) !== pending) return;
			pending.submitting = false;
			void this.#poll(agentId, pending);
		};
	}

	clear(): void {
		for (const agentId of this.#pending.keys()) this.#stop(agentId, { state: 'cleared' });
	}

	#stop(agentId: string, event?: LoginEvent): void {
		const pending = this.#pending.get(agentId);
		if (!pending) return;
		clearTimeout(pending.timer);
		clearTimeout(pending.expiry);
		this.#pending.delete(agentId);
		if (event) pending.listener?.(event);
	}

	#expireAfter(agentId: string, pending: PendingLogin, ms: number): void {
		clearTimeout(pending.expiry);
		pending.expiry = setTimeout(() => {
			if (this.#pending.get(agentId) !== pending) return;
			this.#stop(agentId, { state: 'error', error: 'Sign-in status timed out.' });
		}, ms);
	}

	async #poll(agentId: string, pending: PendingLogin): Promise<void> {
		if (!pending.sessionId) return;
		const revision = pending.revision;
		const current = () => this.#pending.get(agentId) === pending && pending.revision === revision;
		const publish = (event: LoginEvent) => {
			pending.latest = event;
			pending.listener?.(event);
		};
		try {
			if (!pending.confirmingInstance) {
				const status = await getAgentAuthLoginStatus(agentId, pending.sessionId, this.executorId);
				if (!current()) return;
				if (status.state !== 'idle' && status.sessionId === pending.sessionId) {
					publish(status);
					if (status.state === 'failed') { this.#stop(agentId); return; }
					if (status.state === 'succeeded') {
						pending.confirmingInstance = status.instanceId;
						this.#expireAfter(agentId, pending, CREDENTIAL_TIMEOUT_MS);
					}
				}
			}
			if (pending.confirmingInstance) {
				const auth = await getAgentAuthStatus(agentId, this.executorId, pending.confirmingInstance);
				if (!current()) return;
				publish({ state: 'credentials', auth });
				if (auth.authenticated) {
					this.#stop(agentId);
					this.onAuthenticated(agentId, pending.confirmingInstance);
					return;
				}
			}
		} catch (err) {
			if (!current()) return;
			if (err instanceof ApiError && err.errorCode === 'LOGIN_INSTANCE_CHANGED') {
				publish({ state: 'cleared' });
				this.#stop(agentId);
				return;
			}
			if (pending.confirmingInstance) publish({ state: 'credential-error', error: err instanceof Error ? err.message : String(err) });
		}
		pending.timer = setTimeout(() => { void this.#poll(agentId, pending); }, POLL_INTERVAL_MS);
	}
}
