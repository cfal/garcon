import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalClientIdentity } from '../terminal-client-identity.svelte.js';
import { TERMINAL_CLIENT_CLAIM_STORAGE_PREFIX } from '../terminal-client-storage.js';
import { SESSION_STORAGE_KEYS } from '$lib/utils/local-persistence.js';
import { createRandomId } from '$lib/utils/random-id.js';

vi.mock('$lib/utils/random-id.js', () => ({
	createRandomId: vi.fn(),
}));

const mockCreateRandomId = vi.mocked(createRandomId);

const CLAIM_WINDOW_MS = 200;

class FakeBroadcastChannel {
	static instances = new Set<FakeBroadcastChannel>();
	onmessage: ((event: MessageEvent) => void) | null = null;

	constructor(readonly name: string) {
		FakeBroadcastChannel.instances.add(this);
	}

	postMessage(data: unknown): void {
		for (const channel of FakeBroadcastChannel.instances) {
			if (channel !== this && channel.name === this.name) {
				channel.onmessage?.(new MessageEvent('message', { data }));
			}
		}
	}

	close(): void {
		FakeBroadcastChannel.instances.delete(this);
	}
}

function uuid(suffix: number): `${string}-${string}-${string}-${string}-${string}` {
	return `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;
}

describe('TerminalClientIdentity', () => {
	const identities: TerminalClientIdentity[] = [];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		localStorage.clear();
		sessionStorage.clear();
		FakeBroadcastChannel.instances.clear();
		vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
		mockCreateRandomId.mockReset();
	});

	afterEach(() => {
		for (const identity of identities) identity.destroy();
		identities.length = 0;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function create(): TerminalClientIdentity {
		const identity = new TerminalClientIdentity();
		identities.push(identity);
		return identity;
	}

	it('lets an established document keep a copied session identity', () => {
		sessionStorage.setItem(SESSION_STORAGE_KEYS.terminalClientId, 'shared-client');
		mockCreateRandomId
			.mockReturnValueOnce(uuid(1))
			.mockReturnValueOnce(uuid(10))
			.mockReturnValueOnce(uuid(2))
			.mockReturnValueOnce(uuid(20))
			.mockReturnValueOnce(uuid(3))
			.mockReturnValueOnce(uuid(30));

		const owner = create();
		vi.advanceTimersByTime(CLAIM_WINDOW_MS);
		expect(owner.clientId).toBe('shared-client');

		const contender = create();
		vi.advanceTimersByTime(CLAIM_WINDOW_MS);

		expect(owner.clientId).toBe('shared-client');
		expect(contender.clientId).toBe(uuid(3));
	});

	it('arbitrates simultaneous claims by nonce', () => {
		sessionStorage.setItem(SESSION_STORAGE_KEYS.terminalClientId, 'shared-client');
		mockCreateRandomId
			.mockReturnValueOnce(uuid(1))
			.mockReturnValueOnce(uuid(10))
			.mockReturnValueOnce(uuid(2))
			.mockReturnValueOnce(uuid(20))
			.mockReturnValueOnce(uuid(3))
			.mockReturnValueOnce(uuid(30));

		const lowerNonce = create();
		const higherNonce = create();
		vi.advanceTimersByTime(CLAIM_WINDOW_MS);

		expect(lowerNonce.clientId).toBe('shared-client');
		expect(higherNonce.clientId).toBe(uuid(3));
	});

	it('scans active storage fallback claims before establishing', () => {
		vi.stubGlobal('BroadcastChannel', undefined);
		sessionStorage.setItem(SESSION_STORAGE_KEYS.terminalClientId, 'shared-client');
		localStorage.setItem(
			`${TERMINAL_CLIENT_CLAIM_STORAGE_PREFIX}other:probe:1`,
			JSON.stringify({
				type: 'probe',
				candidateId: 'shared-client',
				nonce: uuid(1),
				senderDocumentId: 'other-document',
				sentAt: Date.now(),
			}),
		);
		mockCreateRandomId
			.mockReturnValueOnce(uuid(2))
			.mockReturnValueOnce(uuid(20))
			.mockReturnValueOnce(uuid(3))
			.mockReturnValueOnce(uuid(30))
			.mockReturnValue(uuid(40));

		const identity = create();
		vi.advanceTimersByTime(CLAIM_WINDOW_MS);

		expect(identity.clientId).toBe(uuid(3));
		expect(identity.clientId).not.toBe('shared-client');
	});

	it('does not scan or write storage claims for a fresh channel identity', () => {
		const scan = vi.spyOn(localStorage, 'key');
		localStorage.setItem('unrelated', 'value');
		mockCreateRandomId.mockReturnValue(uuid(5));
		create();
		expect(localStorage.length).toBe(1);
		expect(scan).not.toHaveBeenCalled();
	});

	it.each([false, true])('protects a copied ID across transports (owner has channel: %s)', (channelOwner) => {
		let sequence = 0;
		mockCreateRandomId.mockImplementation(() => uuid(++sequence));
		function deliverClaim(type: string, documentId: string): void {
			for (let i = 0; i < localStorage.length; i++) {
				const key = localStorage.key(i);
				if (!key?.startsWith(TERMINAL_CLIENT_CLAIM_STORAGE_PREFIX)) continue;
				const value = localStorage.getItem(key)!;
				const record = JSON.parse(value);
				if (record.type === type && record.senderDocumentId === documentId) {
					window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
					return;
				}
			}
			throw new Error(`Missing storage claim: ${type}`);
		}
		vi.stubGlobal('BroadcastChannel', channelOwner ? FakeBroadcastChannel : undefined);
		const owner = create();
		vi.advanceTimersByTime(CLAIM_WINDOW_MS + 1);
		const saved = owner.clientId;
		expect(saved).not.toBeNull();
		vi.stubGlobal('BroadcastChannel', channelOwner ? undefined : FakeBroadcastChannel);
		const contender = create();
		deliverClaim('probe', contender.documentId);
		deliverClaim('occupied', owner.documentId);
		vi.advanceTimersByTime(CLAIM_WINDOW_MS * 2);
		expect(owner.clientId).toBe(saved);
		expect(contender.established).toBe(true);
		expect(contender.clientId).not.toBe(saved);
	});

	it('uses storage coordination when BroadcastChannel construction is rejected', () => {
		vi.stubGlobal(
			'BroadcastChannel',
			class RejectedBroadcastChannel {
				constructor() {
					throw new DOMException('Unavailable', 'SecurityError');
				}
			},
		);
		mockCreateRandomId.mockReturnValue(uuid(50));

		const identity = create();
		vi.advanceTimersByTime(CLAIM_WINDOW_MS);

		expect(identity.established).toBe(true);
		expect(identity.clientId).toBe(uuid(50));
	});

	it('retains the same identity after the prior document leaves', () => {
		mockCreateRandomId.mockReturnValue(uuid(1));
		const first = create();
		vi.advanceTimersByTime(CLAIM_WINDOW_MS);
		const retained = first.clientId;
		first.destroy();

		const replacement = create();
		vi.advanceTimersByTime(CLAIM_WINDOW_MS);

		expect(replacement.clientId).toBe(retained);
	});

	it('settles readiness as cancelled when destroyed before establishing a claim', async () => {
		mockCreateRandomId.mockReturnValue(uuid(1));
		const identity = create();
		const initialize = vi.fn();
		const continuation = identity.ready.then((clientId) => {
			if (clientId !== null) initialize(clientId);
		});

		identity.destroy();
		await continuation;
		await expect(identity.ready).resolves.toBeNull();
		vi.advanceTimersByTime(CLAIM_WINDOW_MS);

		expect(initialize).not.toHaveBeenCalled();
		expect(identity.established).toBe(false);
		expect(sessionStorage.getItem(SESSION_STORAGE_KEYS.terminalClientId)).toBeNull();
	});
});
