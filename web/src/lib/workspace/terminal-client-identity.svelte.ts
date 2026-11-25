import {
	SESSION_STORAGE_KEYS,
	getSessionStorageItem,
	setSessionStorageItem,
} from '$lib/utils/local-persistence.js';
import { createRandomId } from '$lib/utils/random-id.js';
import { TERMINAL_CLIENT_CLAIM_STORAGE_PREFIX } from './terminal-client-storage.js';

const CHANNEL_NAME = 'garcon-terminal-client-identity-v1';
const CLAIM_WINDOW_MS = 200;
type ClaimTransport = 'channel' | 'storage';

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
	#savedId = getSessionStorageItem(SESSION_STORAGE_KEYS.terminalClientId);
	#candidateId = this.#savedId ?? createRandomId();
	#nonce = createRandomId();
	#channel: BroadcastChannel | null = null;
	#claimTimer: ReturnType<typeof setTimeout> | null = null;
	#fallbackCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#storageSequence = 0;
	#resolveReady: ((clientId: string | null) => void) | null = null;
	readonly ready = new Promise<string | null>((resolve) => {
		this.#resolveReady = resolve;
	});
	#storage = (event: StorageEvent) => {
		if (!event.key?.startsWith(TERMINAL_CLIENT_CLAIM_STORAGE_PREFIX) || !event.newValue) return;
		try {
			this.#receive(JSON.parse(event.newValue), 'storage');
		} catch {
			// Malformed coordination records are ignored.
		}
	};

	constructor() {
		if (typeof BroadcastChannel !== 'undefined') {
			try {
				this.#channel = new BroadcastChannel(CHANNEL_NAME);
				this.#channel.onmessage = (event) => this.#receive(event.data, 'channel');
			} catch {
				this.#channel = null;
			}
		}
		window.addEventListener('storage', this.#storage);
		if (this.#savedId || !this.#channel) this.#scanFallbackClaims();
		this.#beginClaim();
	}

	destroy(): void {
		this.established = false;
		this.clientId = null;
		this.#resolveReady?.(null);
		this.#resolveReady = null;
		if (this.#claimTimer) clearTimeout(this.#claimTimer);
		this.#claimTimer = null;
		this.#channel?.close();
		this.#channel = null;
		for (const [key, timer] of this.#fallbackCleanupTimers) {
			clearTimeout(timer);
			this.#removeFallbackClaim(key);
		}
		this.#fallbackCleanupTimers.clear();
		window.removeEventListener('storage', this.#storage);
	}

	#beginClaim(): void {
		if (this.#claimTimer) clearTimeout(this.#claimTimer);
		this.established = false;
		// A copied session ID may already belong to a tab using only storage.
		if (!this.#channel || this.#candidateId === this.#savedId) this.#post('probe', 'storage');
		if (this.#channel) this.#post('probe', 'channel');
		this.#claimTimer = setTimeout(() => {
			this.#claimTimer = null;
			this.clientId = this.#candidateId;
			this.established = true;
			setSessionStorageItem(SESSION_STORAGE_KEYS.terminalClientId, this.#candidateId);
			this.#resolveReady?.(this.#candidateId);
			this.#resolveReady = null;
		}, CLAIM_WINDOW_MS);
	}

	#receive(value: unknown, transport: ClaimTransport): void {
		if (!value || typeof value !== 'object') return;
		const message = value as Partial<IdentityMessage>;
		if (message.senderDocumentId === this.documentId || message.candidateId !== this.#candidateId)
			return;
		if (message.type === 'probe') {
			if (this.established) {
				this.#post('occupied', transport);
				return;
			}
			if (typeof message.nonce !== 'string') return;
			if (message.nonce === this.#nonce || this.#nonce > message.nonce) {
				this.#rotateCandidate();
			} else {
				this.#post('probe', transport);
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

	#post(type: IdentityMessage['type'], transport: ClaimTransport): void {
		const message = {
			type,
			candidateId: this.#candidateId,
			nonce: this.#nonce,
			senderDocumentId: this.documentId,
			sentAt: Date.now(),
		} satisfies IdentityMessage;
		if (transport === 'channel') {
			this.#channel?.postMessage(message);
			return;
		}
		const key = `${TERMINAL_CLIENT_CLAIM_STORAGE_PREFIX}${this.documentId}:${++this.#storageSequence}`;
		try {
			localStorage.setItem(key, JSON.stringify(message));
			const timer = setTimeout(() => {
				this.#fallbackCleanupTimers.delete(key);
				this.#removeFallbackClaim(key);
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
			).filter((key): key is string => Boolean(key?.startsWith(TERMINAL_CLIENT_CLAIM_STORAGE_PREFIX)));
			for (const key of keys) {
				const raw = localStorage.getItem(key);
				if (!raw) continue;
				try {
					const message = JSON.parse(raw) as Partial<IdentityMessage>;
					if (typeof message.sentAt !== 'number' || now - message.sentAt > CLAIM_WINDOW_MS) {
						this.#removeFallbackClaim(key);
						continue;
					}
					this.#receive(message, 'storage');
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
