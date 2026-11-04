import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitReviewWorkerClient, type GitReviewWorkerPort } from '../git-review-worker-client.js';
import {
	GIT_REVIEW_WORKER_LIMITS as LIMITS,
	type GitReviewWorkerReply,
	type GitReviewWorkerRequest,
} from '../git-review-worker-protocol.js';
import { createGitPatchIndex, getGitSplitPatchIndex } from '../git-patch-index.js';

class WorkerDouble implements GitReviewWorkerPort {
	onmessage: GitReviewWorkerPort['onmessage'] = null;
	onerror: GitReviewWorkerPort['onerror'] = null;
	onmessageerror: GitReviewWorkerPort['onmessageerror'] = null;
	postMessage = vi.fn<(request: GitReviewWorkerRequest) => void>();
	terminate = vi.fn();
	reply() {
		const request = this.postMessage.mock.calls.at(-1)![0];
		if (request.input.kind !== 'index') throw new Error('Expected index');
		const index = createGitPatchIndex(request.input.patch, request.input.renderedRowCount);
		const data: GitReviewWorkerReply = {
			id: request.id,
			status: 'ready',
			timings: [],
			output: {
				kind: 'index',
				index: index.toData(),
				split: getGitSplitPatchIndex(index).toData(),
			},
		};
		this.onmessage?.({ data } as MessageEvent<GitReviewWorkerReply>);
	}
}
const input = { kind: 'index' as const, patch: '@@ -0,0 +1 @@\n+synthetic\n', renderedRowCount: 2 };
const clients: GitReviewWorkerClient[] = [];
function setup() {
	const workers: WorkerDouble[] = [];
	const client = new GitReviewWorkerClient(() => {
		const worker = new WorkerDouble();
		workers.push(worker);
		return worker;
	});
	clients.push(client);
	return { client, workers };
}
afterEach(() => {
	for (const client of clients.splice(0)) client.dispose();
	vi.useRealTimers();
});

describe('review Worker admission and lifetime', () => {
	it('retains one Worker across sequential requests and returns cloneable data', async () => {
		const { client, workers } = setup();
		const first = client.run(input);
		workers[0].reply();
		await first;
		const second = client.run(input);
		workers[0].reply();
		expect(structuredClone(await second).kind).toBe('index');
		expect(workers).toHaveLength(1);
	});
	it('terminates active synchronous work and fences its saved callback after replacement', async () => {
		const { client, workers } = setup();
		const abort = new AbortController();
		const old = client.run(input, abort.signal).catch((error) => error);
		const callback = workers[0].onmessage!;
		const next = client.run(input);
		abort.abort();
		expect((await old).name).toBe('AbortError');
		expect(workers[0].terminate).toHaveBeenCalledOnce();
		expect(workers).toHaveLength(2);
		callback({
			data: { id: 1, status: 'error', message: 'late failure' },
		} as MessageEvent<GitReviewWorkerReply>);
		workers[1].reply();
		await expect(next).resolves.toMatchObject({ kind: 'index' });
	});
	it("removes cancelled queued work without terminating another surface's active request", async () => {
		const { client, workers } = setup();
		const abort = new AbortController();
		const first = client.run(input);
		const queued = client.run(input, abort.signal).catch((error) => error);
		abort.abort();
		expect((await queued).name).toBe('AbortError');
		expect(workers[0].terminate).not.toHaveBeenCalled();
		workers[0].reply();
		await first;
		expect(workers[0].postMessage).toHaveBeenCalledOnce();
	});
	it('bounds admission before cloning input', async () => {
		const { client, workers } = setup();
		const pending = Array.from({ length: LIMITS.maxPendingRequests }, () =>
			client.run(input).catch((error) => error),
		);
		await expect(client.run(input)).rejects.toThrow('admission');
		await expect(client.run({ ...input, renderedRowCount: Infinity })).rejects.toThrow('limit');
		await expect(
			client.run({ ...input, patch: 'x'.repeat(LIMITS.maxPatchCharacters + 1) }),
		).rejects.toThrow('limit');
		expect(workers[0].postMessage).toHaveBeenCalledOnce();
		client.dispose();
		await Promise.all(pending);
	});

	it('bounds retained UTF-16 bytes independently of request count', async () => {
		const { client } = setup();
		const large = { ...input, patch: 'x'.repeat(LIMITS.maxPatchCharacters) };
		const first = client.run(large).catch((error) => error);
		const second = client.run(large).catch((error) => error);
		await expect(client.run(large)).rejects.toThrow('admission');
		client.dispose();
		await Promise.all([first, second]);
	});

	it('recycles language memory after the bounded job lifetime', async () => {
		const { client, workers } = setup();
		for (let job = 0; job < LIMITS.maxJobsPerWorker; job += 1) {
			const result = client.run(input);
			workers[0].reply();
			await result;
		}
		expect(workers[0].terminate).toHaveBeenCalledOnce();
		const next = client.run(input);
		workers[1].reply();
		await next;
	});

	it('rejects a clone failure and starts the next request on a fresh Worker', async () => {
		const worker = new WorkerDouble();
		worker.postMessage.mockImplementation(() => {
			throw new DOMException('Synthetic clone failure', 'DataCloneError');
		});
		const replacement = new WorkerDouble();
		const create = vi.fn(() => replacement).mockReturnValueOnce(worker);
		const client = new GitReviewWorkerClient(create);
		clients.push(client);
		await expect(client.run(input)).rejects.toThrow('Diff Worker unavailable.');
		expect(worker.terminate).toHaveBeenCalledOnce();
		const next = client.run(input);
		replacement.reply();
		await next;
	});
	it('enforces a main-thread deadline without cooperation from the Worker', async () => {
		vi.useFakeTimers();
		const { client, workers } = setup();
		const result = client.run(input).catch((error) => error);
		await vi.advanceTimersByTimeAsync(LIMITS.requestTimeoutMs);
		expect((await result).message).toContain('deadline');
		expect(workers[0].terminate).toHaveBeenCalledOnce();
	});
	it('retires idle language memory and restarts lazily', async () => {
		vi.useFakeTimers();
		const { client, workers } = setup();
		const result = client.run(input);
		workers[0].reply();
		await result;
		await vi.advanceTimersByTimeAsync(LIMITS.idleTimeoutMs);
		expect(workers[0].terminate).toHaveBeenCalledOnce();
		const next = client.run(input);
		workers[1].reply();
		await next;
	});
	it('contains Worker startup, clone and asynchronous failures', async () => {
		const client = new GitReviewWorkerClient(() => {
			throw new Error('CSP denied');
		});
		clients.push(client);
		await expect(client.run(input)).rejects.toThrow('CSP denied');
		const { client: running, workers } = setup();
		const result = running.run(input).catch((error) => error);
		workers[0].onerror?.(new ErrorEvent('error'));
		expect((await result).message).toContain('unavailable');
	});
});
