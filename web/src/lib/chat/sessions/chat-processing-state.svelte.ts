import type {
	ChatProcessingEntry,
	ChatProcessingPhase,
	ChatProcessingTiming,
} from '$shared/chat-types';
import type { ChatProcessingTransition } from './chat-sessions-contract.js';
import { ProcessingTimingState } from './processing-timing-state.svelte.js';

export class ChatProcessingState {
	#snapshot: Map<string, ChatProcessingPhase> | null = null;
	readonly #overrides = new Map<string, ChatProcessingPhase | null>();
	readonly #timings = new ProcessingTimingState();

	phaseFor(chatId: string, fallback: ChatProcessingPhase | null): ChatProcessingPhase | null {
		if (this.#overrides.has(chatId)) return this.#overrides.get(chatId) ?? null;
		return this.#snapshot ? (this.#snapshot.get(chatId) ?? null) : fallback;
	}

	timingFor(chatId: string) {
		return this.#timings.forChat(chatId);
	}

	applyEvent(
		chatId: string,
		phase: ChatProcessingPhase | null,
		timing: ChatProcessingTiming | null,
	): void {
		this.#overrides.set(chatId, phase);
		if (phase && timing) this.#timings.observe(chatId, timing);
		else this.#timings.clear(chatId);
	}

	forget(chatId: string): void {
		this.#overrides.delete(chatId);
		this.#snapshot?.delete(chatId);
		this.#timings.clear(chatId);
	}

	reconcile(
		entries: readonly ChatProcessingEntry[],
		fallbacks: ReadonlyMap<string, ChatProcessingPhase | null>,
	): {
		phases: ReadonlyMap<string, ChatProcessingPhase>;
		transitions: ChatProcessingTransition[];
	} {
		const phases = new Map(entries.map((entry) => [entry.chatId, entry.phase]));
		const chatIds = new Set([
			...fallbacks.keys(),
			...(this.#snapshot?.keys() ?? []),
			...this.#overrides.keys(),
			...phases.keys(),
		]);
		const transitions = [...chatIds].map((chatId) => ({
			chatId,
			previousPhase: this.phaseFor(chatId, fallbacks.get(chatId) ?? null),
			phase: phases.get(chatId) ?? null,
		}));
		this.#snapshot = phases;
		this.#overrides.clear();
		this.#timings.reconcile(entries);
		return {
			phases,
			transitions: transitions.filter((entry) => entry.previousPhase !== entry.phase),
		};
	}
}
