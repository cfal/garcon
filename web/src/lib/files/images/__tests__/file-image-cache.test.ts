import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { ApiError } from '$lib/api/client.js';
import type { getFileRevision, readContent } from '$lib/api/files.js';
import { FileImageCache, type FileImageTarget } from '../file-image-cache.svelte.js';
import type { decodeFileImage } from '../decode-file-image.js';

const MiB = 1024 * 1024;
const target: FileImageTarget = {
	executorId: 'worker',
	executorContextKey: 'worker-instance-1',
	projectPath: '/workspace',
	filePath: 'capture.png',
};
const result = { blob: new Blob(['pixels'], { type: 'image/png' }), revision: 'v1:first' };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

describe('FileImageCache', () => {
	const caches: FileImageCache[] = [];
	function setup(budgetBytes = 64 * MiB) {
		const read = vi.fn<typeof readContent>().mockResolvedValue(result);
		const revision = vi
			.fn<typeof getFileRevision>()
			.mockResolvedValue({ status: 'ready', revision: result.revision });
		const decode = vi.fn<typeof decodeFileImage>().mockResolvedValue({ width: 1600, height: 900 });
		const cache = new FileImageCache({
			budgetBytes,
			readContent: read,
			getFileRevision: revision,
			decode,
		});
		caches.push(cache);
		return { cache, read, revision, decode };
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
		let id = 0;
		vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${++id}`);
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	});
	afterEach(() => {
		for (const cache of caches.splice(0)) cache.destroy();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('shares lazy reads and immediately returns retained images to new consumers', async () => {
		const { cache, read, revision } = setup();
		const first = cache.acquire(target);
		const second = cache.acquire({ ...target });
		expect(read).not.toHaveBeenCalled();
		await Promise.all([first.ensureCurrent(), second.ensureCurrent()]);
		expect(read).toHaveBeenCalledExactlyOnceWith(
			{ executorId: 'worker', projectPath: '/workspace', filePath: 'capture.png' },
			{ signal: expect.any(AbortSignal), cache: 'no-store' },
		);
		expect(first.image).toBe(second.image);
		const image = first.image;
		first.release();
		second.release();
		const restored = cache.acquire(target);
		expect(restored.image).toBe(image);
		await restored.ensureCurrent();
		expect(read).toHaveBeenCalledOnce();
		expect(revision).not.toHaveBeenCalled();
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
	});

	it('aborts cold reads only after the last lease releases and fences late responses', async () => {
		const { cache, read } = setup();
		const pending = deferred<typeof result>();
		read.mockReturnValueOnce(pending.promise);
		const first = cache.acquire(target);
		const second = cache.acquire(target);
		const loading = first.ensureCurrent();
		const signal = read.mock.calls[0][1]!.signal!;
		first.release();
		expect(signal.aborted).toBe(false);
		second.release();
		expect(signal.aborted).toBe(true);
		pending.resolve(result);
		await loading;
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it('revokes an unpublished candidate when decoding finishes after release', async () => {
		const { cache, decode } = setup();
		const pending = deferred<{ width: number; height: number }>();
		decode.mockReturnValueOnce(pending.promise);
		const lease = cache.acquire(target);
		const loading = lease.ensureCurrent();
		await tick();
		expect(decode).toHaveBeenCalledOnce();
		lease.release();
		pending.resolve({ width: 1600, height: 900 });
		await loading;
		expect(lease.image).toBeNull();
		expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:image-1');
	});

	it('rejects late responses after clearing and leaves a replacement request intact', async () => {
		const { cache, read } = setup();
		const firstRead = deferred<typeof result>();
		const nextRead = deferred<typeof result>();
		read.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(nextRead.promise);
		const old = cache.acquire(target);
		const oldLoading = old.ensureCurrent();
		cache.clear();
		const replacement = cache.acquire(target);
		const loading = replacement.ensureCurrent();
		old.release();
		firstRead.resolve(result);
		await oldLoading;
		expect(replacement.ensureCurrent()).toBe(loading);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
		nextRead.resolve(result);
		await loading;
		expect(replacement.image?.url).toBe('blob:image-1');
		expect(read).toHaveBeenCalledTimes(2);
	});

	it('isolates executors, incarnations, roots, and paths', async () => {
		const { cache, read } = setup();
		for (const location of [
			target,
			{ ...target, executorId: 'other' },
			{ ...target, executorContextKey: 'instance-2' },
			{ ...target, projectPath: '/other' },
			{ ...target, filePath: 'other.png' },
		]) {
			const lease = cache.acquire(location);
			await lease.ensureCurrent();
			lease.release();
		}
		expect(read).toHaveBeenCalledTimes(5);
	});

	it('evicts least recently used idle images after the handoff grace', async () => {
		const { cache } = setup(12 * MiB);
		const leases = [];
		for (const filePath of ['first.png', 'second.png', 'third.png']) {
			const lease = cache.acquire({ ...target, filePath });
			await lease.ensureCurrent();
			lease.release();
			leases.push(lease);
		}
		await vi.advanceTimersByTimeAsync(999);
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(leases[0].image).toBeNull();
		expect(leases[1].image).not.toBeNull();
		expect(leases[2].image).not.toBeNull();
	});

	it('allows outgoing images to release before incoming images reacquire', async () => {
		const { cache, read } = setup(8 * MiB);
		const first = cache.acquire(target);
		await first.ensureCurrent();
		first.release();
		await vi.advanceTimersByTimeAsync(5000);
		const second = cache.acquire({ ...target, filePath: 'second.png' });
		await second.ensureCurrent();
		second.release();
		const returning = cache.acquire(target);
		expect(returning.image?.url).toBe('blob:image-1');
		await returning.ensureCurrent();
		expect(read).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1000);
		expect(second.image).not.toBeNull();
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
	});

	it('re-arms trimming for over-budget images still within their release grace', async () => {
		const { cache, read } = setup(8 * MiB);
		const first = cache.acquire(target);
		await first.ensureCurrent();
		first.release();
		await vi.advanceTimersByTimeAsync(500);
		const second = cache.acquire({ ...target, filePath: 'second.png' });
		const third = cache.acquire({ ...target, filePath: 'third.png' });
		await Promise.all([second.ensureCurrent(), third.ensureCurrent()]);
		second.release();
		third.release();
		await vi.advanceTimersByTimeAsync(500);
		expect(first.image).toBeNull();
		expect(second.image).not.toBeNull();
		expect(third.image).not.toBeNull();
		await vi.advanceTimersByTimeAsync(500);
		expect(second.image).toBeNull();
		expect(third.image).not.toBeNull();
		expect(read).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('evicts an oversized idle image without displacing images that fit', async () => {
		const { cache, decode } = setup(8 * MiB);
		const retained = cache.acquire(target);
		await retained.ensureCurrent();
		retained.release();
		await vi.advanceTimersByTimeAsync(5000);
		decode.mockResolvedValue({ width: 2000, height: 2000 });
		const oversized = cache.acquire({ ...target, filePath: 'oversized.png' });
		await oversized.ensureCurrent();
		oversized.release();
		expect(retained.image?.url).toBe('blob:image-1');
		await vi.advanceTimersByTimeAsync(1000);
		expect(oversized.image).toBeNull();
		expect(retained.image?.url).toBe('blob:image-1');
		expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:image-2');
	});

	it('trims immediately on budget reduction without evicting active images', async () => {
		const { cache } = setup();
		const active = cache.acquire(target);
		await active.ensureCurrent();
		const idle = cache.acquire({ ...target, filePath: 'idle.png' });
		await idle.ensureCurrent();
		idle.release();
		cache.setIdleBudget(0);
		expect(idle.image).toBeNull();
		expect(active.image?.url).toBe('blob:image-1');
		active.release();
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
	});

	it('counts file bytes and decoded pixels, evicting oversized images once idle', async () => {
		const { cache, read, decode } = setup(8 * MiB);
		read.mockResolvedValue({
			blob: new Blob([new Uint8Array(2 * MiB)], { type: 'image/png' }),
			revision: 'v1:large',
		});
		decode.mockResolvedValue({ width: 1536, height: 1024 });
		const lease = cache.acquire(target);
		await lease.ensureCurrent();
		expect(lease.image?.estimatedBytes).toBe(8 * MiB);
		lease.release();
		await vi.advanceTimersByTimeAsync(1000);
		expect(lease.image).not.toBeNull();
		cache.setIdleBudget(8 * MiB - 1);
		expect(lease.image).toBeNull();
	});

	it('bounds tiny idle entries as well as estimated bytes', async () => {
		const { cache, decode } = setup(512 * MiB);
		decode.mockResolvedValue({ width: 1, height: 1 });
		const first = cache.acquire(target);
		await first.ensureCurrent();
		first.release();
		for (let index = 0; index < 256; index += 1) {
			const lease = cache.acquire({ ...target, filePath: `${index}.png` });
			await lease.ensureCurrent();
			lease.release();
		}
		await vi.advanceTimersByTimeAsync(1000);
		expect(first.image).toBeNull();
		expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
	});

	it('checks revisions without downloading or replacing unchanged images', async () => {
		const { cache, read, revision } = setup();
		const lease = cache.acquire(target);
		await lease.ensureCurrent();
		const image = lease.image;
		await vi.advanceTimersByTimeAsync(30_000);
		await lease.ensureCurrent();
		expect(revision).toHaveBeenCalledExactlyOnceWith(
			{ executorId: 'worker', projectPath: '/workspace', filePath: 'capture.png' },
			{ signal: expect.any(AbortSignal), cache: 'no-store' },
		);
		expect(lease.image).toBe(image);
		expect(read).toHaveBeenCalledOnce();
	});

	it('keeps the old image until replacement decode and ignores old display errors', async () => {
		const { cache, read, revision, decode } = setup();
		const lease = cache.acquire(target);
		await lease.ensureCurrent();
		const oldImage = lease.image!;
		await vi.advanceTimersByTimeAsync(30_000);
		revision.mockResolvedValue({ status: 'ready', revision: 'v1:changed' });
		read.mockResolvedValue({ ...result, revision: 'v1:changed-again' });
		const pending = deferred<{ width: number; height: number }>();
		decode.mockReturnValueOnce(pending.promise);
		const refresh = lease.ensureCurrent();
		await tick();
		expect(lease.image).toBe(oldImage);
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		pending.resolve({ width: 100, height: 100 });
		await refresh;
		expect(lease.image).toMatchObject({ url: 'blob:image-2', revision: 'v1:changed-again' });
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldImage.url);
		lease.reportDisplayError(oldImage.url);
		expect(lease.failed).toBe(false);
	});

	it('cancels refresh on last release while preserving the previous image', async () => {
		const { cache, revision } = setup();
		const lease = cache.acquire(target);
		await lease.ensureCurrent();
		const image = lease.image;
		await vi.advanceTimersByTimeAsync(30_000);
		const pending = deferred<Awaited<ReturnType<typeof getFileRevision>>>();
		revision.mockReturnValueOnce(pending.promise);
		const refresh = lease.ensureCurrent();
		lease.release();
		expect(revision.mock.calls[0][1]?.signal?.aborted).toBe(true);
		const restored = cache.acquire(target);
		await restored.ensureCurrent();
		pending.resolve({ status: 'missing' });
		await refresh;
		expect(restored.image).toBe(image);
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
	});

	it.each([
		new TypeError('Network failure'),
		new ApiError(503, 'Unavailable'),
		new ApiError(403, 'Retry', 'RETRY', undefined, true),
	])('preserves stale images and throttles transient failures: %s', async (error) => {
		const { cache, revision } = setup();
		const lease = cache.acquire(target);
		await lease.ensureCurrent();
		await vi.advanceTimersByTimeAsync(30_000);
		revision.mockRejectedValue(error);
		await lease.ensureCurrent();
		await lease.ensureCurrent();
		expect(lease.image).not.toBeNull();
		expect(revision).toHaveBeenCalledOnce();
	});

	it('retains images across temporary auth suspension and retries after recovery', async () => {
		const { cache, revision } = setup();
		const lease = cache.acquire(target);
		await lease.ensureCurrent();
		await vi.advanceTimersByTimeAsync(30_000);
		revision.mockRejectedValueOnce(new ApiError(401, 'Sign in', 'AUTH_SESSION_INVALID'));
		await lease.ensureCurrent();
		expect(lease.image).not.toBeNull();
		await lease.ensureCurrent();
		expect(revision).toHaveBeenCalledTimes(2);
	});

	it.each(['missing', 'forbidden', 'content-type', 'decode'])(
		'drops definitive %s failures instead of retaining obsolete content',
		async (failure) => {
			const { cache, revision, read, decode } = setup();
			const lease = cache.acquire(target);
			await lease.ensureCurrent();
			await vi.advanceTimersByTimeAsync(30_000);
			revision.mockResolvedValue({ status: 'ready', revision: 'v1:changed' });
			if (failure === 'missing') revision.mockResolvedValue({ status: 'missing' });
			if (failure === 'forbidden') revision.mockRejectedValue(new ApiError(403, 'Denied'));
			if (failure === 'content-type')
				read.mockResolvedValue({ ...result, blob: new Blob(['private'], { type: 'text/plain' }) });
			if (failure === 'decode') decode.mockRejectedValue(new Error('Undecodable'));
			await lease.ensureCurrent();
			expect(lease.failed).toBe(true);
			expect(lease.image).toBeNull();
			expect(cache.acquire(target).failed).toBe(false);
		},
	);

	it('invalidates live leases on owner changes and never lets old releases affect replacements', async () => {
		const { cache } = setup();
		cache.setOwner('first-user');
		const old = cache.acquire(target);
		await old.ensureCurrent();
		const generation = cache.generation;
		cache.setOwner(null);
		expect(cache.available).toBe(false);
		expect(cache.generation).toBeGreaterThan(generation);
		expect(old.image).toBeNull();
		cache.setOwner('second-user');
		const replacement = cache.acquire(target);
		await replacement.ensureCurrent();
		old.release();
		old.release();
		cache.setIdleBudget(0);
		expect(replacement.image?.url).toBe('blob:image-2');
		cache.destroy();
		replacement.release();
		expect(replacement.image).toBeNull();
		expect(cache.acquire(target).failed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
