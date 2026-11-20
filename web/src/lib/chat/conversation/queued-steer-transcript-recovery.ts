import { getChatMessages } from '$lib/api/chats.js';
import type { ChatTranscriptAppliedCursor } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { OptimisticUserInput, QueuedSteerDelivery } from '$lib/chat/transcript/optimistic-user-input.js';

type ReadHead = (chatId: string, transcriptViewId: string) => Promise<number | null>;

async function readTranscriptHead(chatId: string, transcriptViewId: string): Promise<number | null> {
	const page = await getChatMessages({ chatId, transcriptViewId, limit: 1 }, { cache: 'no-store' });
	return page.lastOrdinal ?? null;
}

/** A head read started after queue departure bounds the echo, even outside the recovery page. */
export class QueuedSteerTranscriptRecovery {
	#heads = new WeakMap<QueuedSteerDelivery, number | 'reading'>();

	constructor(private readonly options: {
		inputs(chatId: string): readonly OptimisticUserInput[];
		cursor(chatId: string): ChatTranscriptAppliedCursor | null;
		clear(chatId: string, clientMessageId: string): void;
		readHead?: ReadHead;
	}) {}

	observe(chatId: string): void {
		const reads = new Map<string, QueuedSteerDelivery[]>();
		for (const { delivery } of this.options.inputs(chatId)) {
			if (typeof delivery !== 'object' || delivery.queuedAtVersion !== null || this.#heads.has(delivery)) continue;
			this.#heads.set(delivery, 'reading');
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
			if (typeof delivery !== 'object' || delivery.transcriptViewId !== cursor.transcriptViewId) continue;
			const head = this.#heads.get(delivery);
			if (typeof head === 'number' && cursor.lastOrdinal >= head) this.options.clear(chatId, delivery.clientMessageId);
		}
	}

	async #read(chatId: string, viewId: string, cohort: QueuedSteerDelivery[]): Promise<void> {
		let head: number | null = null;
		try {
			head = await (this.options.readHead ?? readTranscriptHead)(chatId, viewId);
		} catch {
			// An unavailable read proves nothing. The next control or snapshot retries it.
		}
		for (const delivery of cohort) {
			if (!this.#heads.has(delivery)) continue;
			if (head !== null) this.#heads.set(delivery, head);
			else this.#heads.delete(delivery);
		}
		if (head !== null) this.retireCaughtUp(chatId);
	}

	destroy(): void { this.#heads = new WeakMap(); }
}
