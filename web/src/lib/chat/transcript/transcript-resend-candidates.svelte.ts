import type { ResendCandidate } from '$shared/chat-view';

// Unanswered inputs the server offers to resend, minus the ones the user has dismissed. The
// exclusions outlive a candidate refresh, so a dismissal survives until the row itself does not.
export class TranscriptResendCandidates {
	#candidates = $state<ResendCandidate[]>([]);
	#excludedOrdinals = $state<number[]>([]);

	get all(): readonly ResendCandidate[] {
		return this.#candidates;
	}

	get included(): readonly ResendCandidate[] {
		const excluded = new Set(this.#excludedOrdinals);
		return this.#candidates.filter((candidate) => !excluded.has(candidate.ordinal));
	}

	get excludedOrdinals(): readonly number[] {
		return this.#excludedOrdinals;
	}

	replace(candidates: readonly ResendCandidate[]): void {
		this.#candidates = candidates.map((candidate) => ({
			...candidate,
			attachmentNames: [...candidate.attachmentNames],
		}));
		const available = new Set(candidates.map((candidate) => candidate.ordinal));
		this.#excludedOrdinals = this.#excludedOrdinals.filter((ordinal) => available.has(ordinal));
	}

	exclude(ordinal: number): void {
		if (!this.#candidates.some((candidate) => candidate.ordinal === ordinal)) return;
		if (this.#excludedOrdinals.includes(ordinal)) return;
		this.#excludedOrdinals = [...this.#excludedOrdinals, ordinal].sort((left, right) => left - right);
	}

	clearExclusions(): void {
		this.#excludedOrdinals = [];
	}

	clear(): void {
		this.#candidates = [];
		this.#excludedOrdinals = [];
	}
}
