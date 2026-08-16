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

	clearMany(clientMessageIds: ReadonlySet<string>): void {
		if (clientMessageIds.size === 0) return;
		const next = this.rows.filter((input) => !clientMessageIds.has(input.clientMessageId));
		if (next.length === this.rows.length) return;
		for (const clientMessageId of clientMessageIds) {
			this.#afterOrdinalByClientMessageId.delete(clientMessageId);
		}
		this.rows = next;
		this.onChanged();
	}

	clearAll(): void {
		if (this.rows.length === 0) return;
		this.#afterOrdinalByClientMessageId.clear();
		this.rows = [];
		this.onChanged();
	}
}
