import type {
	ResendCandidate,
	TranscriptAppend,
} from '$shared/chat-view';

export type TranscriptReplayApplyResult = 'applied' | 'view-changed' | 'gap-detected';

export type TranscriptBufferedBatch = Pick<
	TranscriptAppend,
	'firstOrdinal' | 'lastOrdinal' | 'messages'
> & {
	transcriptViewId: string;
	noticeRevision: number;
	resendCandidates: ResendCandidate[];
};

interface ActiveReconnectReplay {
	token: number;
	chatId: string;
	transcriptViewId: string;
	buffered: TranscriptBufferedBatch[];
}

type ApplyBufferedBatch = (
	chatId: string,
	batch: TranscriptBufferedBatch,
) => TranscriptReplayApplyResult;

export class TranscriptReconnectReplayState {
	#epoch = 0;
	#active: ActiveReconnectReplay | null = null;
	#applyingToken: number | null = null;

	constructor(private readonly apply: ApplyBufferedBatch) {}

	begin(chatId: string, transcriptViewId: string): number {
		const token = ++this.#epoch;
		this.#active = { token, chatId, transcriptViewId, buffered: [] };
		return token;
	}

	applyPage(
		token: number,
		chatId: string,
		batch: TranscriptBufferedBatch,
	): TranscriptReplayApplyResult | 'stale' {
		if (!this.#matches(token, chatId, batch.transcriptViewId)) return 'stale';

		this.#applyingToken = token;
		try {
			return this.apply(chatId, batch);
		} finally {
			this.#applyingToken = null;
		}
	}

	buffer(chatId: string, batch: TranscriptBufferedBatch): boolean {
		const replay = this.#active;
		if (!replay || replay.token === this.#applyingToken || replay.chatId !== chatId) {
			return false;
		}
		replay.buffered.push(batch);
		return true;
	}

	finish(
		token: number,
		chatId: string,
	): TranscriptReplayApplyResult | 'stale' {
		const replay = this.#active;
		if (!replay || replay.token !== token || replay.chatId !== chatId) return 'stale';

		this.#active = null;
		for (const batch of replay.buffered) {
			const result = this.apply(chatId, batch);
			if (result !== 'applied') return result;
		}
		return 'applied';
	}

	abort(token: number): void {
		if (this.#active?.token === token) this.#active = null;
	}

	reset(): void {
		this.#active = null;
	}

	#matches(token: number, chatId: string, transcriptViewId: string): boolean {
		return this.#active?.token === token
			&& this.#active.chatId === chatId
			&& this.#active.transcriptViewId === transcriptViewId;
	}
}
