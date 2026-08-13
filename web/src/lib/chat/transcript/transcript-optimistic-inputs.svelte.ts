import type { OptimisticUserInput } from './optimistic-user-input.js';

export class TranscriptOptimisticInputs {
	rows = $state<OptimisticUserInput[]>([]);

	constructor(private readonly onChanged: () => void) {}

	upsert(input: OptimisticUserInput): void {
		const next = this.rows.filter((entry) => entry.clientMessageId !== input.clientMessageId);
		next.push(input);
		this.rows = next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
		this.onChanged();
	}

	clear(clientMessageId: string): void {
		const next = this.rows.filter((input) => input.clientMessageId !== clientMessageId);
		if (next.length === this.rows.length) return;
		this.rows = next;
		this.onChanged();
	}

	clearMany(clientMessageIds: ReadonlySet<string>): void {
		if (clientMessageIds.size === 0) return;
		const next = this.rows.filter((input) => !clientMessageIds.has(input.clientMessageId));
		if (next.length === this.rows.length) return;
		this.rows = next;
		this.onChanged();
	}

	clearAll(): void {
		if (this.rows.length === 0) return;
		this.rows = [];
		this.onChanged();
	}
}
