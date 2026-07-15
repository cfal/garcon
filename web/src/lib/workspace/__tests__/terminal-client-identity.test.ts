import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalClientIdentity } from '../terminal-client-identity.svelte.js';
import { SESSION_STORAGE_KEYS } from '$lib/utils/local-persistence.js';
import { createRandomId } from '$lib/utils/random-id.js';

vi.mock('$lib/utils/random-id.js', () => ({
	createRandomId: vi.fn(),
}));

const mockCreateRandomId = vi.mocked(createRandomId);

const CLAIM_WINDOW_MS = 200;
const FALLBACK_STORAGE_PREFIX = 'garcon_terminal_client_identity_claim_v1:';

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
			`${FALLBACK_STORAGE_PREFIX}other:probe:1`,
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
});
