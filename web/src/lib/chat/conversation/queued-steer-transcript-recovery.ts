import { getChatMessages } from '$lib/api/chats.js';
import type { ChatTranscriptAppliedCursor } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { OptimisticUserInput, QueuedSteerDelivery } from '$lib/chat/transcript/optimistic-user-input.js';

type ReadHead = (chatId: string, transcriptViewId: string) => Promise<number | null>;
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000];

async function readTranscriptHead(chatId: string, transcriptViewId: string): Promise<number | null> {
	const page = await getChatMessages({ chatId, transcriptViewId, limit: 1 }, { cache: 'no-store' });
	return page.lastOrdinal ?? null;
}

/** A head read started after queue departure bounds the echo, even outside the recovery page. */
export class QueuedSteerTranscriptRecovery {
	#heads = new WeakMap<QueuedSteerDelivery, number | 'pending'>();
	#retryTimers = new Set<ReturnType<typeof setTimeout>>();
	#destroyed = false;

	constructor(private readonly options: {
		inputs(chatId: string): readonly OptimisticUserInput[];
		cursor(chatId: string): ChatTranscriptAppliedCursor | null;
		clear(chatId: string, clientMessageId: string): void;
		readHead?: ReadHead;
	}) {}

	observe(chatId: string): void {
		if (this.#destroyed) return;
		const reads = new Map<string, QueuedSteerDelivery[]>();
		for (const { delivery } of this.options.inputs(chatId)) {
			if (typeof delivery !== 'object' || delivery.queuedAtVersion !== null || this.#heads.has(delivery)) continue;
			this.#heads.set(delivery, 'pending');
			const cohort = reads.get(delivery.transcriptViewId);
			if (cohort) cohort.push(delivery);
			else reads.set(delivery.transcriptViewId, [delivery]);
		}
		for (const [viewId, cohort] of reads) void this.#read(chatId, viewId, cohort);
		this.retireCaughtUp(chatId);
	}

	retireCaughtUp(chatId: string): void {
		const inputs = this.options.inputs(chatId);
		if (!inputs.length) return;
		const cursor = this.options.cursor(chatId);
		if (!cursor || cursor.stale) return;
		for (const { delivery } of inputs) {
			if (typeof delivery !== 'object') continue;
			if (delivery.transcriptViewId !== cursor.transcriptViewId) {
				this.options.clear(chatId, delivery.clientMessageId);
				continue;
			}
			const head = this.#heads.get(delivery);
			if (typeof head === 'number' && cursor.lastOrdinal >= head) this.options.clear(chatId, delivery.clientMessageId);
		}
	}

	#currentCohort(chatId: string, cohort: QueuedSteerDelivery[]): QueuedSteerDelivery[] {
		if (this.#destroyed) return [];
		const current = new Set(this.options.inputs(chatId).map(input => input.delivery));
		return cohort.filter(delivery => current.has(delivery) && this.#heads.get(delivery) === 'pending');
	}

	async #read(chatId: string, viewId: string, cohort: QueuedSteerDelivery[], retryIndex = 0): Promise<void> {
		cohort = this.#currentCohort(chatId, cohort);
		if (!cohort.length) return;
		let head: number | null = null;
		try {
			head = await (this.options.readHead ?? readTranscriptHead)(chatId, viewId);
		} catch {
			// An unavailable read proves nothing, even if the chat has gone quiet.
		}
		cohort = this.#currentCohort(chatId, cohort);
		if (!cohort.length) return;
		if (head !== null) {
			for (const delivery of cohort) this.#heads.set(delivery, head);
			this.retireCaughtUp(chatId);
			return;
		}
		const timer = setTimeout(() => {
			this.#retryTimers.delete(timer);
			void this.#read(chatId, viewId, cohort, Math.min(retryIndex + 1, RETRY_DELAYS.length - 1));
		}, RETRY_DELAYS[retryIndex]);
		this.#retryTimers.add(timer);
	}

	destroy(): void {
		this.#destroyed = true;
		for (const timer of this.#retryTimers) clearTimeout(timer);
		this.#retryTimers.clear();
		this.#heads = new WeakMap();
	}
}
