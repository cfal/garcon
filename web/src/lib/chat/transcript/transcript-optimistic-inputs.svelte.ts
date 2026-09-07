import type { OptimisticUserInput } from './optimistic-user-input.js';

export class TranscriptOptimisticInputs {
	rows = $state<OptimisticUserInput[]>([]);
	#afterOrdinalByClientMessageId = new Map<string, number>();

	constructor(private readonly onChanged: () => void) {}

	get afterOrdinalByClientMessageId(): ReadonlyMap<string, number> {
		return this.#afterOrdinalByClientMessageId;
	}

	upsert(input: OptimisticUserInput, afterOrdinal: number): void {
		if (!this.#afterOrdinalByClientMessageId.has(input.clientMessageId)) {
			this.#afterOrdinalByClientMessageId.set(input.clientMessageId, afterOrdinal);
		}
		const existingIndex = this.rows.findIndex(
			(entry) => entry.clientMessageId === input.clientMessageId,
		);
		if (existingIndex === -1) this.rows = [...this.rows, input];
		else this.rows = this.rows.with(existingIndex, input);
		this.onChanged();
	}

	markDelivered(clientMessageId: string): void {
		const index = this.rows.findIndex((input) => input.clientMessageId === clientMessageId);
		const input = this.rows[index];
		if (!input || input.delivery === 'delivered') return;
		const next = [...this.rows];
		next[index] = { ...input, delivery: 'delivered' };
		this.rows = next;
		this.onChanged();
	}

	clear(clientMessageId: string): void {
		const next = this.rows.filter((input) => input.clientMessageId !== clientMessageId);
		if (next.length === this.rows.length) return;
		this.#afterOrdinalByClientMessageId.delete(clientMessageId);
		this.rows = next;
		this.onChanged();
	}

	clearEchoed(echoedOrdinals: ReadonlyMap<string, number>): void {
		if (echoedOrdinals.size === 0) return;
		const remaining: OptimisticUserInput[] = [];
		let latestPriorEchoOrdinal: number | undefined;
		for (const input of this.rows) {
			const echoOrdinal = echoedOrdinals.get(input.clientMessageId);
			if (echoOrdinal !== undefined) {
				latestPriorEchoOrdinal = Math.max(latestPriorEchoOrdinal ?? 0, echoOrdinal);
				this.#afterOrdinalByClientMessageId.delete(input.clientMessageId);
				continue;
			}
			if (latestPriorEchoOrdinal !== undefined) {
				const currentOrdinal = this.#afterOrdinalByClientMessageId.get(input.clientMessageId) ?? 0;
				this.#afterOrdinalByClientMessageId.set(
					input.clientMessageId,
					Math.max(currentOrdinal, latestPriorEchoOrdinal),
				);
			}
			remaining.push(input);
		}
		if (remaining.length === this.rows.length) return;
		this.rows = remaining;
		this.onChanged();
	}

	clearAll(): void {
		if (this.rows.length === 0) return;
		this.#afterOrdinalByClientMessageId.clear();
		this.rows = [];
		this.onChanged();
	}
}
