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
	readonly #supersededInstanceIds = new Set<string>();

	markSocketDisconnected(): void {
		this.#confirmedSocketInstanceId = null;
	}

	confirmSocketInstance(serverInstanceId: string): ExecutionControlInstanceAcceptance {
		this.#confirmedSocketInstanceId = serverInstanceId;
		if (this.#currentInstanceId === serverInstanceId) return { kind: 'current' };
		return this.#replaceCurrent(serverInstanceId);
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
