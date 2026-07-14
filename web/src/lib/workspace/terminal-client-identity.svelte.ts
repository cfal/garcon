import {
	SESSION_STORAGE_KEYS,
	getSessionStorageItem,
	setSessionStorageItem,
} from '$lib/utils/local-persistence.js';
import { createRandomId } from '$lib/utils/random-id.js';

const CHANNEL_NAME = 'garcon-terminal-client-identity-v1';
const FALLBACK_STORAGE_PREFIX = 'garcon_terminal_client_identity_claim_v1:';
const CLAIM_WINDOW_MS = 200;

type IdentityMessage = {
	type: 'probe' | 'occupied';
	candidateId: string;
	nonce: string;
	senderDocumentId: string;
	sentAt: number;
};

export class TerminalClientIdentity {
	clientId = $state<string | null>(null);
	established = $state(false);
	readonly documentId = createRandomId();
	#candidateId = getSessionStorageItem(SESSION_STORAGE_KEYS.terminalClientId) ?? createRandomId();
	#nonce = createRandomId();
	#channel: BroadcastChannel | null = null;
	#claimTimer: ReturnType<typeof setTimeout> | null = null;
	#fallbackCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#resolveReady: ((clientId: string) => void) | null = null;
	readonly ready = new Promise<string>((resolve) => {
		this.#resolveReady = resolve;
	});
	#pageHide = () => this.destroy();
	#storage = (event: StorageEvent) => {
		if (!event.key?.startsWith(FALLBACK_STORAGE_PREFIX) || !event.newValue) return;
		try {
			this.#receive(JSON.parse(event.newValue));
		} catch {
			// Malformed coordination records are ignored.
		}
	};

	constructor() {
		if (typeof BroadcastChannel !== 'undefined') {
			try {
				this.#channel = new BroadcastChannel(CHANNEL_NAME);
				this.#channel.onmessage = (event) => this.#receive(event.data);
			} catch {
				this.#channel = null;
			}
		}
		window.addEventListener('storage', this.#storage);
		window.addEventListener('pagehide', this.#pageHide, { once: true });
		this.#scanFallbackClaims();
		this.#beginClaim();
	}

	destroy(): void {
		this.established = false;
		if (this.#claimTimer) clearTimeout(this.#claimTimer);
		this.#claimTimer = null;
		this.#channel?.close();
		this.#channel = null;
		for (const [key, timer] of this.#fallbackCleanupTimers) {
			clearTimeout(timer);
			this.#removeFallbackClaim(key);
		}
		this.#fallbackCleanupTimers.clear();
		window.removeEventListener('pagehide', this.#pageHide);
		window.removeEventListener('storage', this.#storage);
	}

	#beginClaim(): void {
		if (this.#claimTimer) clearTimeout(this.#claimTimer);
		this.established = false;
		this.#post('probe');
		this.#claimTimer = setTimeout(() => {
			this.#claimTimer = null;
			this.clientId = this.#candidateId;
			this.established = true;
			setSessionStorageItem(SESSION_STORAGE_KEYS.terminalClientId, this.#candidateId);
			this.#resolveReady?.(this.#candidateId);
			this.#resolveReady = null;
		}, CLAIM_WINDOW_MS);
	}

	#receive(value: unknown): void {
		if (!value || typeof value !== 'object') return;
		const message = value as Partial<IdentityMessage>;
		if (message.senderDocumentId === this.documentId || message.candidateId !== this.#candidateId)
			return;
		if (message.type === 'probe') {
			if (this.established) {
				this.#post('occupied');
				return;
			}
			if (typeof message.nonce !== 'string') return;
			if (message.nonce === this.#nonce || this.#nonce > message.nonce) {
				this.#rotateCandidate();
			} else {
				this.#post('probe');
			}
			return;
		}
		if (message.type === 'occupied' && !this.established) this.#rotateCandidate();
	}

	#rotateCandidate(): void {
		this.#candidateId = createRandomId();
		this.#nonce = createRandomId();
		this.#beginClaim();
	}

	#post(type: IdentityMessage['type']): void {
		const message = {
			type,
			candidateId: this.#candidateId,
			nonce: this.#nonce,
			senderDocumentId: this.documentId,
			sentAt: Date.now(),
		} satisfies IdentityMessage;
		if (this.#channel) {
			this.#channel.postMessage(message);
			return;
		}
		const key = `${FALLBACK_STORAGE_PREFIX}${this.documentId}:${type}:${message.sentAt}:${createRandomId()}`;
		try {
			localStorage.setItem(key, JSON.stringify(message));
			const timer = setTimeout(() => {
				this.#fallbackCleanupTimers.delete(key);
				setTimeout(() => this.#removeFallbackClaim(key), 0);
			}, CLAIM_WINDOW_MS);
			this.#fallbackCleanupTimers.set(key, timer);
		} catch {
			// Session-local identity remains usable when storage is unavailable.
		}
	}

	#scanFallbackClaims(): void {
		try {
			const now = Date.now();
			const keys = Array.from({ length: localStorage.length }, (_, index) =>
				localStorage.key(index),
			).filter((key): key is string => Boolean(key?.startsWith(FALLBACK_STORAGE_PREFIX)));
			for (const key of keys) {
				const raw = localStorage.getItem(key);
				if (!raw) continue;
				try {
					const message = JSON.parse(raw) as Partial<IdentityMessage>;
					if (typeof message.sentAt !== 'number' || now - message.sentAt > CLAIM_WINDOW_MS) {
						this.#removeFallbackClaim(key);
						continue;
					}
					this.#receive(message);
				} catch {
					this.#removeFallbackClaim(key);
				}
			}
		} catch {
			// Storage scanning is optional coordination.
		}
	}

	#removeFallbackClaim(key: string): void {
		try {
			localStorage.removeItem(key);
		} catch {
			// Storage cleanup is best effort.
		}
	}
}
