import type { ResendSnapshot, ResendSnapshotRequest } from '$shared/transcript-display-auxiliary';

function sameTarget(left: ResendSnapshotRequest | null, right: ResendSnapshotRequest | null): boolean {
	return left?.chatId === right?.chatId && left?.transcriptViewId === right?.transcriptViewId
		&& left?.serverInstanceId === right?.serverInstanceId;
}

export class ResendCandidatesController {
	snapshot = $state.raw<ResendSnapshot | null>(null);
	error = $state<string | null>(null);
	#head = $state(0);
	#target: ResendSnapshotRequest | null = null;
	#epoch = 0;
	#abort: AbortController | null = null;
	#request: Promise<ResendSnapshot | null> | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#dirty = false;

	constructor(
		private readonly read: (request: ResendSnapshotRequest, signal: AbortSignal) => Promise<ResendSnapshot>,
		private readonly accept: (snapshot: ResendSnapshot) => void,
	) {}

	get current(): ResendSnapshot | null {
		return !this.error && this.snapshot?.processingPhase === null && this.snapshot.sourceHead >= this.#head
			? this.snapshot : null;
	}

	activate(target: ResendSnapshotRequest | null, head: number): void {
		if (sameTarget(target, this.#target)) { this.observeHead(head); return; }
		this.reset();
		this.#target = target;
		this.#head = head;
		if (target) this.#schedule();
	}

	observeHead(head: number): void {
		if (!this.#target || head <= this.#head) return;
		this.#head = head;
		this.#schedule();
	}

	refresh(): Promise<ResendSnapshot | null> {
		if (this.#request) return this.#request;
		const target = this.#target;
		if (!target) return Promise.resolve(null);
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#dirty = false;
		const epoch = this.#epoch, abort = new AbortController();
		this.#abort = abort;
		const request = this.read(target, abort.signal).then(snapshot => {
			if (abort.signal.aborted || epoch !== this.#epoch) return null;
			if (!sameTarget(snapshot, target)) throw new Error('Foreign resend snapshot');
			if (snapshot.sourceHead < this.#head) return null;
			this.snapshot = snapshot;
			this.error = null;
			this.#dirty = false;
			if (snapshot.processingPhase === null) this.accept(snapshot);
			return this.current;
		}).catch((error: unknown) => {
			if (!abort.signal.aborted && epoch === this.#epoch) this.error = error instanceof Error ? error.message : 'Resend candidates unavailable';
			return null;
		}).finally(() => {
			if (this.#request !== request) return;
			this.#request = null;
			this.#abort = null;
			if (this.#dirty) this.#schedule();
		});
		this.#request = request;
		return request;
	}

	#schedule(): void {
		this.#dirty = true;
		if (this.#request || this.#timer !== null) return;
		this.#timer = setTimeout(() => { this.#timer = null; void this.refresh(); }, 250);
	}

	reset(): void {
		this.#epoch++;
		this.#abort?.abort();
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#abort = null;
		this.#request = null;
		this.#target = null;
		this.#dirty = false;
		this.#head = 0;
		this.snapshot = null;
		this.error = null;
	}
}
