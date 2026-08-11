import type { PendingUserInput } from '$shared/pending-user-input';
import type { UserMessageDeliveryStatus } from '$shared/chat-types';
import { sortPendingInputs } from './transcript-row-projection.js';

// Pending user inputs overlaying the active transcript. Rows carry a revision
// watermark so a snapshot load can tell whether live updates raced it, and
// every replacement funnels through one owner-supplied side effect.
export class TranscriptPendingInputs {
	rows = $state<PendingUserInput[]>([]);
	#revision = 0;
	#revisionAtLoadStart = 0;

	constructor(private readonly onChanged: () => void) {}

	get unchangedSinceLoadStart(): boolean {
		return this.#revision === this.#revisionAtLoadStart;
	}

	markLoadStart(): void {
		this.#revisionAtLoadStart = this.#revision;
	}

	replace(inputs: PendingUserInput[]): void {
		this.#revision += 1;
		this.rows = sortPendingInputs(inputs);
		this.onChanged();
	}

	upsert(input: PendingUserInput): void {
		const next = this.rows.slice();
		const index = next.findIndex((entry) => entry.clientRequestId === input.clientRequestId);
		if (index >= 0) next[index] = input;
		else next.push(input);
		this.replace(next);
	}

	clear(clientRequestId: string): void {
		const next = this.rows.filter((input) => input.clientRequestId !== clientRequestId);
		if (next.length === this.rows.length) return;
		this.replace(next);
	}

	setDeliveryStatus(clientRequestId: string, deliveryStatus: UserMessageDeliveryStatus): void {
		const current = this.rows.find((input) => input.clientRequestId === clientRequestId);
		if (!current || current.deliveryStatus === deliveryStatus) return;
		this.replace(
			this.rows.map((input) =>
				input.clientRequestId === clientRequestId ? { ...input, deliveryStatus } : input,
			),
		);
	}
}
