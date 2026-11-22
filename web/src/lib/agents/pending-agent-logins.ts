import {
	getAgentAuthLoginStatus, getAgentAuthStatus, type AgentAuthLoginStatus, type AgentAuthStatus,
} from '$lib/api/agents.js';

type LoginEvent = Exclude<AgentAuthLoginStatus, { state: 'idle' }>
	| { state: 'cleared' }
	| { state: 'credentials'; auth: AgentAuthStatus }
	| { state: 'credential-error'; error: string };
type Listener = (event: LoginEvent) => void;

interface PendingLogin {
	sessionId: string;
	listener?: Listener;
	latest?: LoginEvent;
	confirming: boolean;
	submitting?: boolean;
	revision: number;
	timer?: ReturnType<typeof setTimeout>;
	expiry?: ReturnType<typeof setTimeout>;
}

const POLL_INTERVAL_MS = 1500;
// Allows the CLI's 15-minute watchdog to publish its own terminal status first.
const SESSION_TIMEOUT_MS = 16 * 60_000;
const CREDENTIAL_TIMEOUT_MS = 5 * 60_000;

/** Owns session-qualified login polling on one executor, independent of the Settings view. */
export class PendingAgentLogins {
	#pending = new Map<string, PendingLogin>();

	constructor(private readonly executorId: string, private readonly onAuthenticated: () => void) {}

	sessionId(agentId: string): string | undefined {
		return this.#pending.get(agentId)?.sessionId;
	}

	observe(agentId: string, sessionId: string, listener: Listener): () => void {
		let pending = this.#pending.get(agentId);
		if (pending?.sessionId === sessionId) {
			pending.listener = listener;
			// Restores the form, but only a fresh status can authorize another submission.
			if (pending.latest?.state === 'running') listener({ ...pending.latest, completionPending: true });
			else if (pending.latest) listener(pending.latest);
		} else {
			this.#stop(agentId);
			pending = { sessionId, listener, confirming: false, revision: 0 };
			this.#pending.set(agentId, pending);
			this.#expireAfter(agentId, pending, SESSION_TIMEOUT_MS);
			void this.#poll(agentId, pending);
		}
		return () => { if (pending.listener === listener) pending.listener = undefined; };
	}

	beginSubmission(agentId: string, sessionId: string): (() => void) | undefined {
		const pending = this.#pending.get(agentId);
		if (pending?.sessionId !== sessionId || pending.submitting || pending.confirming) return;
		pending.submitting = true;
		clearTimeout(pending.timer);
		pending.revision++;
		if (pending.latest?.state === 'running') {
			pending.latest = { ...pending.latest, completionPending: true, retryableError: undefined };
		}
		return () => {
			if (this.#pending.get(agentId) !== pending) return;
			pending.submitting = false;
			void this.#poll(agentId, pending);
		};
	}

	clear(): void {
		for (const [agentId, pending] of this.#pending) {
			this.#stop(agentId);
			pending.listener?.({ state: 'cleared' });
		}
	}

	#stop(agentId: string): void {
		const pending = this.#pending.get(agentId);
		if (!pending) return;
		clearTimeout(pending.timer);
		clearTimeout(pending.expiry);
		this.#pending.delete(agentId);
	}

	#expireAfter(agentId: string, pending: PendingLogin, ms: number): void {
		clearTimeout(pending.expiry);
		pending.expiry = setTimeout(() => {
			if (this.#pending.get(agentId) !== pending) return;
			pending.listener?.({ state: 'failed', running: false, sessionId: pending.sessionId, error: 'Sign-in status timed out.' });
			this.#stop(agentId);
		}, ms);
	}

	async #poll(agentId: string, pending: PendingLogin): Promise<void> {
		const revision = pending.revision;
		const current = () => this.#pending.get(agentId) === pending && pending.revision === revision;
		const publish = (event: LoginEvent) => {
			pending.latest = event;
			pending.listener?.(event);
		};
		try {
			if (!pending.confirming) {
				const status = await getAgentAuthLoginStatus(agentId, pending.sessionId, this.executorId);
				if (!current()) return;
				if (status.state !== 'idle' && status.sessionId === pending.sessionId) {
					publish(status);
					if (status.state === 'failed') return this.#stop(agentId);
					if (status.state === 'succeeded') {
						pending.confirming = true;
						this.#expireAfter(agentId, pending, CREDENTIAL_TIMEOUT_MS);
					}
				}
			}
			if (pending.confirming) {
				const auth = await getAgentAuthStatus(agentId, this.executorId);
				if (!current()) return;
				publish({ state: 'credentials', auth });
				if (auth.authenticated) {
					this.#stop(agentId);
					this.onAuthenticated();
					return;
				}
			}
		} catch (err) {
			if (!current()) return;
			if (pending.confirming) publish({ state: 'credential-error', error: err instanceof Error ? err.message : String(err) });
		}
		pending.timer = setTimeout(() => { void this.#poll(agentId, pending); }, POLL_INTERVAL_MS);
	}
}
