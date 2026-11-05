import type { DisplayBody, DisplayCertificate } from '$shared/transcript-display-contract';

type BodyIdentity = Pick<DisplayCertificate, 'serverInstanceId' | 'chatId' | 'transcriptViewId'>;
interface CachedBody { body: DisplayBody; bytes: number }
export interface DisplayBodyUsage { readonly count: number; readonly bytes: number; readonly oversized: number }
const OVERSIZED_BODY_BYTES = 2 * 1024 * 1024;

function key(identity: BodyIdentity, ordinal: number): string {
	return JSON.stringify([identity.serverInstanceId, identity.chatId, identity.transcriptViewId, ordinal]);
}

export class DisplayBodyStore {
	#instance = '';
	#bodies = new Map<string, CachedBody>();
	#leases = new Map<object, ReadonlySet<string>>();
	#parked = new Set<object>();
	#bytes = 0;
	#evictions = 0;
	#received = 0;

	constructor(readonly limits = { count: 2000, bytes: 48 * 1024 * 1024 }) {}

	get count(): number { return this.#bodies.size; }
	get estimatedBytes(): number { return this.#bytes; }
	get overBudget(): boolean { return this.count > this.limits.count || this.#bytes > this.limits.bytes; }
	get activeOverBudget(): boolean {
		const addresses = new Set<string>();
		for (const [owner, lease] of this.#leases) if (!this.#parked.has(owner)) for (const address of lease) addresses.add(address);
		let count = 0, bytes = 0;
		for (const address of addresses) {
			const body = this.#bodies.get(address);
			if (body) { count++; bytes += body.bytes; }
		}
		return count > this.limits.count || bytes > this.limits.bytes;
	}
	get metrics() {
		return { bodies: this.count, bytes: this.#bytes, owners: this.#leases.size, received: this.#received, evictions: this.#evictions,
			budgetException: this.activeOverBudget, oversized: [...this.#bodies.values()].filter(body => body.bytes > OVERSIZED_BODY_BYTES).length };
	}
	setParked(owner: object, parked: boolean): void { if (parked) this.#parked.add(owner); else this.#parked.delete(owner); }

	usage(owner: object): DisplayBodyUsage {
		let count = 0, bytes = 0, oversized = 0;
		for (const address of this.#leases.get(owner) ?? []) {
			const body = this.#bodies.get(address);
			if (!body) continue;
			count++; bytes += body.bytes;
			if (body.bytes > OVERSIZED_BODY_BYTES) oversized++;
		}
		return { count, bytes, oversized };
	}

	resetInstance(serverInstanceId: string): void {
		if (this.#instance === serverInstanceId) return;
		this.clear();
		this.#instance = serverInstanceId;
	}

	get(identity: BodyIdentity, ordinal: number): DisplayBody | undefined {
		return this.#bodies.get(key(identity, ordinal))?.body;
	}

	put(identity: BodyIdentity, bodies: readonly DisplayBody[]): void {
		if (identity.serverInstanceId !== this.#instance) throw new Error('Stale display body instance');
		for (const body of bodies) {
			const address = key(identity, body.ordinal);
			if (this.#bodies.has(address)) continue;
			const bytes = JSON.stringify(body).length * 2;
			this.#bodies.set(address, { body, bytes });
			this.#bytes += bytes;
			this.#received++;
		}
	}

	retain(owner: object, identity: BodyIdentity, ordinals: Iterable<number>): void {
		this.#leases.set(owner, new Set(Array.from(ordinals, ordinal => key(identity, ordinal))));
		this.prune();
	}

	release(owner: object): void {
		this.#leases.delete(owner);
		this.#parked.delete(owner);
		this.prune();
	}

	residentOrdinals(identity: BodyIdentity, ordinals: Iterable<number>): number[] {
		return Array.from(ordinals).filter(ordinal => this.get(identity, ordinal) !== undefined);
	}

	prune(): void {
		const protectedKeys = new Set<string>();
		for (const lease of this.#leases.values()) for (const address of lease) protectedKeys.add(address);
		// Unleased member bodies are released immediately, including on collapse.
		for (const [address, cached] of this.#bodies) {
			if (protectedKeys.has(address)) continue;
			this.#bodies.delete(address);
			this.#bytes -= cached.bytes;
			this.#evictions++;
		}
	}

	clear(): void {
		this.#bodies.clear();
		this.#leases.clear();
		this.#parked.clear();
		this.#bytes = 0;
	}
}
