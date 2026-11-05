import {
	GIT_REVIEW_WORKER_LIMITS as LIMITS,
	reviewWorkerInputBytes,
	type GitReviewWorkerInput,
	type GitReviewWorkerOutput,
	type GitReviewWorkerReply,
	type GitReviewWorkerRequest,
} from './git-review-worker-protocol.js';
import { recordGitReviewWorkerTimings } from './git-review-performance.js';

export interface GitReviewWorkerPort {
	onmessage: ((event: MessageEvent<GitReviewWorkerReply>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	onmessageerror: ((event: MessageEvent) => void) | null;
	postMessage(request: GitReviewWorkerRequest): void;
	terminate(): void;
}

interface Request {
	id: number;
	input: GitReviewWorkerInput;
	bytes: number;
	resolve: (output: GitReviewWorkerOutput) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

// Shares bounded admission across review surfaces; their existing demand schedulers own priority.
export class GitReviewWorkerClient {
	private worker: GitReviewWorkerPort | null = null;
	private active: Request | null = null;
	private queue: Request[] = [];
	private bytes = 0;
	private sequence = 0;
	private completed = 0;
	private idle: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly createWorker: () => GitReviewWorkerPort) {}

	run(input: GitReviewWorkerInput, signal?: AbortSignal): Promise<GitReviewWorkerOutput> {
		if (signal?.aborted)
			return Promise.reject(new DOMException('Diff work cancelled.', 'AbortError'));
		let bytes: number;
		try {
			bytes = reviewWorkerInputBytes(input);
		} catch (error) {
			return Promise.reject(error);
		}
		if (
			this.queue.length + Number(this.active !== null) >= LIMITS.maxPendingRequests ||
			this.bytes + bytes > LIMITS.maxPendingBytes
		) {
			return Promise.reject(new Error('Diff Worker admission limit reached.'));
		}
		return new Promise((resolve, reject) => {
			const request: Request = {
				id: ++this.sequence,
				input,
				bytes,
				resolve,
				reject,
				cleanup: () => {
					clearTimeout(timer);
					signal?.removeEventListener('abort', abort);
				},
			};
			const abort = () =>
				this.fail(request, new DOMException('Diff work cancelled.', 'AbortError'));
			const timer = setTimeout(
				() => this.fail(request, new Error('Diff Worker deadline exceeded.')),
				LIMITS.requestTimeoutMs,
			);
			signal?.addEventListener('abort', abort, { once: true });
			this.bytes += bytes;
			this.queue.push(request);
			this.pump();
		});
	}

	dispose(): void {
		const requests = [...this.queue, ...(this.active ? [this.active] : [])];
		this.queue = [];
		this.active = null;
		this.retire();
		for (const request of requests)
			this.settle(request, new DOMException('Diff work cancelled.', 'AbortError'));
	}

	private pump(): void {
		if (this.active) return;
		if (this.idle) clearTimeout(this.idle);
		this.idle = null;
		const request = this.queue.shift();
		if (!request) {
			this.idle = setTimeout(() => this.retire(), LIMITS.idleTimeoutMs);
			return;
		}
		this.active = request;
		try {
			this.worker ??= this.createWorker();
			const worker = this.worker;
			worker.onmessage = ({ data }) => {
				if (this.worker !== worker || this.active !== request || data.id !== request.id) return;
				if (data.status === 'error') {
					this.fail(request, new Error(data.message));
					return;
				}
				if (data.output.kind !== request.input.kind) {
					this.fail(request, new Error('Invalid diff Worker reply.'));
					return;
				}
				this.active = null;
				worker.onmessage = worker.onerror = worker.onmessageerror = null;
				recordGitReviewWorkerTimings(data.timings);
				this.settle(request, null, data.output);
				if (++this.completed >= LIMITS.maxJobsPerWorker) this.retire();
				this.pump();
			};
			worker.onerror = worker.onmessageerror = () => {
				if (this.worker === worker) this.fail(request, new Error('Diff Worker unavailable.'));
			};
			worker.postMessage({ id: request.id, input: request.input });
		} catch (error) {
			this.fail(request, error instanceof Error ? error : new Error('Diff Worker unavailable.'));
		}
	}

	private fail(request: Request, error: Error): void {
		if (this.active === request) {
			this.active = null;
			// Termination interrupts synchronous parsers; an abort message cannot.
			this.retire();
		} else {
			const index = this.queue.indexOf(request);
			if (index < 0) return;
			this.queue.splice(index, 1);
		}
		this.settle(request, error);
		this.pump();
	}

	private settle(request: Request, error: Error | null, output?: GitReviewWorkerOutput): void {
		request.cleanup();
		this.bytes -= request.bytes;
		if (error) request.reject(error);
		else request.resolve(output!);
	}

	private retire(): void {
		if (this.idle) clearTimeout(this.idle);
		this.idle = null;
		if (this.worker) {
			this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
			this.worker.terminate();
		}
		this.worker = null;
		this.completed = 0;
	}
}

export const gitReviewWorker = new GitReviewWorkerClient(
	() => new Worker(new URL('./git-review-worker.ts', import.meta.url), { type: 'module' }),
);
