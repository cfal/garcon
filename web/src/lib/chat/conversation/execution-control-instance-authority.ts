export type ExecutionControlInstanceAcceptance = { kind: 'current' } | { kind: 'replace' };

export type ExecutionControlInstanceDecision =
	| ExecutionControlInstanceAcceptance
	| {
			kind: 'reject';
			reason: 'confirmed-socket-mismatch' | 'superseded-instance';
			currentInstanceId: string | null;
			confirmedSocketInstanceId: string | null;
	  };

/** Resolves opaque process identities using correlated socket responses as authority. */
export class ExecutionControlInstanceAuthority {
	#currentInstanceId: string | null = null;
	#confirmedSocketInstanceId: string | null = null;
	#authorityRevision = 0;
	#instanceObservedAt = -Infinity;
	readonly #supersededInstanceIds = new Set<string>();

	markSocketDisconnected(): void {
		this.#confirmedSocketInstanceId = null;
	}

	isSocketInstanceConfirmed(serverInstanceId: string): boolean {
		return this.#confirmedSocketInstanceId === serverInstanceId;
	}

	captureResponseFence(): (serverInstanceId: string) => boolean {
		const revision = this.#authorityRevision;
		return serverInstanceId => serverInstanceId === this.#currentInstanceId || revision === this.#authorityRevision;
	}

	confirmSocketInstance(serverInstanceId: string, probeStartedAt?: number): ExecutionControlInstanceAcceptance | null {
		// An older probe cannot order a process observed while its response was in flight.
		if (probeStartedAt !== undefined && !this.acceptsSocketObservation(serverInstanceId, probeStartedAt)) return null;
		if (this.#confirmedSocketInstanceId !== serverInstanceId) this.#authorityRevision += 1;
		this.#confirmedSocketInstanceId = serverInstanceId;
		if (this.#currentInstanceId === serverInstanceId) return { kind: 'current' };
		return this.#replaceCurrent(serverInstanceId);
	}

	acceptsSocketObservation(serverInstanceId: string, startedAt: number): boolean {
		return serverInstanceId === this.#currentInstanceId || startedAt > this.#instanceObservedAt;
	}

	classifyNonAuthoritativeInstance(serverInstanceId: string): ExecutionControlInstanceDecision {
		if (
			this.#confirmedSocketInstanceId !== null &&
			serverInstanceId !== this.#confirmedSocketInstanceId
		) {
			return this.#reject('confirmed-socket-mismatch');
		}
		if (this.#currentInstanceId === serverInstanceId) return { kind: 'current' };
		if (this.#supersededInstanceIds.has(serverInstanceId)) {
			return this.#reject('superseded-instance');
		}
		return this.#replaceCurrent(serverInstanceId);
	}

	#replaceCurrent(serverInstanceId: string): ExecutionControlInstanceAcceptance {
		this.#authorityRevision += 1;
		this.#instanceObservedAt = performance.now();
		if (this.#currentInstanceId !== null) {
			this.#supersededInstanceIds.add(this.#currentInstanceId);
		}
		this.#supersededInstanceIds.delete(serverInstanceId);
		this.#currentInstanceId = serverInstanceId;
		return { kind: 'replace' };
	}

	#reject(
		reason: 'confirmed-socket-mismatch' | 'superseded-instance',
	): ExecutionControlInstanceDecision {
		return {
			kind: 'reject',
			reason,
			currentInstanceId: this.#currentInstanceId,
			confirmedSocketInstanceId: this.#confirmedSocketInstanceId,
		};
	}
}
