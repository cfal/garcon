import { tick, untrack } from 'svelte';
import { ApiError } from '$lib/api/client.js';
import { getFileRevision, readContent } from '$lib/api/files.js';
import type { FileRevision } from '$shared/file-contracts';
import { decodeFileImage } from './decode-file-image.js';

export interface FileImageTarget {
	executorId: string;
	executorContextKey: string;
	projectPath: string;
	filePath: string;
}

interface CachedImage {
	url: string;
	revision: FileRevision;
	estimatedBytes: number;
}

export interface FileImageLease {
	readonly image: CachedImage | null;
	readonly failed: boolean;
	ensureCurrent(): Promise<void>;
	reportDisplayError(url: string): void;
	release(): void;
}

interface CacheOptions {
	budgetBytes: number;
	owner?: string | null;
	readContent?: typeof readContent;
	getFileRevision?: typeof getFileRevision;
	decode?: typeof decodeFileImage;
}

const REVALIDATE_AFTER_MS = 30_000;
const RELEASE_GRACE_MS = 1_000;
const MAX_IDLE_IMAGES = 256;
const MIN_IMAGE_BYTES = 16 * 1024;

class ImageEntry {
	image = $state.raw<CachedImage | null>(null);
	failed = $state(false);
	refs = 0;
	checkedAt = -Infinity;
	releasedAt = 0;
	operation: { controller: AbortController; promise: Promise<void> } | null = null;

	constructor(
		readonly key: string,
		readonly target: FileImageTarget,
	) {}
}

class InvalidImageError extends Error {}

export class FileImageCache {
	readonly #entries = new Map<string, ImageEntry>();
	readonly #idle = new Map<string, ImageEntry>();
	#budgetBytes: number;
	#owner: string | null;
	#generation = $state(0);
	#destroyed = false;
	#trimTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: CacheOptions) {
		this.#budgetBytes = options.budgetBytes;
		this.#owner = options.owner === undefined ? 'standalone' : options.owner;
	}

	get generation(): number {
		return this.#generation;
	}

	get available(): boolean {
		void this.#generation;
		return !this.#destroyed && this.#owner !== null;
	}

	setOwner(owner: string | null): void {
		if (owner === this.#owner) return;
		this.#owner = owner;
		this.clear();
	}

	setIdleBudget(bytes: number): void {
		this.#budgetBytes = Math.max(0, bytes);
		untrack(() => this.#trimIdle(Infinity));
	}

	acquire(target: FileImageTarget): FileImageLease {
		return untrack(() => {
			const key = JSON.stringify([
				target.executorId,
				target.executorContextKey,
				target.projectPath,
				target.filePath,
			]);
			let entry = this.#entries.get(key);
			if (!entry) {
				entry = new ImageEntry(key, { ...target });
				if (this.available) this.#entries.set(key, entry);
				else entry.failed = true;
			}
			const acquired = entry;
			acquired.refs += 1;
			this.#idle.delete(key);
			let released = false;
			return {
				get image() {
					return acquired.image;
				},
				get failed() {
					return acquired.failed;
				},
				ensureCurrent: () =>
					untrack(() => {
						if (released || !this.#isCurrent(acquired)) return Promise.resolve();
						return this.#ensureCurrent(acquired);
					}),
				reportDisplayError: (url) =>
					untrack(() => {
						if (!released && url && acquired.image?.url === url) this.#drop(acquired);
					}),
				release: () =>
					untrack(() => {
						if (released) return;
						released = true;
						this.#release(acquired);
					}),
			};
		});
	}

	clear(): void {
		untrack(() => {
			clearTimeout(this.#trimTimer);
			this.#trimTimer = undefined;
			for (const entry of this.#entries.values()) this.#drop(entry);
			this.#generation += 1;
		});
	}

	destroy(): void {
		this.#destroyed = true;
		this.clear();
	}

	#isCurrent(entry: ImageEntry): boolean {
		return this.available && this.#entries.get(entry.key) === entry;
	}

	#release(entry: ImageEntry): void {
		entry.refs -= 1;
		if (entry.refs > 0 || !this.#isCurrent(entry)) return;
		this.#cancel(entry);
		if (!entry.image || this.#budgetBytes === 0) {
			this.#drop(entry);
			return;
		}
		entry.releasedAt = Date.now();
		this.#idle.set(entry.key, entry);
		// Incoming chat rows can reacquire older idle images after outgoing effects release.
		this.#scheduleTrim(RELEASE_GRACE_MS);
	}

	#cancel(entry: ImageEntry): void {
		const operation = entry.operation;
		entry.operation = null;
		operation?.controller.abort();
	}

	#drop(entry: ImageEntry): void {
		if (this.#entries.get(entry.key) === entry) {
			this.#entries.delete(entry.key);
			this.#idle.delete(entry.key);
		}
		this.#cancel(entry);
		if (entry.image) URL.revokeObjectURL(entry.image.url);
		entry.image = null;
		entry.failed = true;
	}

	#scheduleTrim(delay: number): void {
		this.#trimTimer ??= setTimeout(
			() => untrack(() => this.#trimIdle(Date.now() - RELEASE_GRACE_MS)),
			delay,
		);
	}

	#trimIdle(releasedBefore: number): void {
		clearTimeout(this.#trimTimer);
		this.#trimTimer = undefined;
		let bytes = 0;
		let retainedCount = 0;
		// Oversized images expire independently instead of displacing retainable images.
		for (const entry of this.#idle.values()) {
			const size = entry.image?.estimatedBytes ?? 0;
			if (size > this.#budgetBytes) continue;
			bytes += size;
			retainedCount += 1;
		}
		for (const entry of this.#idle.values()) {
			const size = entry.image?.estimatedBytes ?? 0;
			const oversized = size > this.#budgetBytes;
			if (!oversized && bytes <= this.#budgetBytes && retainedCount <= MAX_IDLE_IMAGES) continue;
			if (entry.releasedAt > releasedBefore) {
				this.#scheduleTrim(Math.max(1, entry.releasedAt + RELEASE_GRACE_MS - Date.now()));
				continue;
			}
			if (!oversized) {
				bytes -= size;
				retainedCount -= 1;
			}
			this.#drop(entry);
		}
	}

	#ensureCurrent(entry: ImageEntry): Promise<void> {
		if (entry.operation) return entry.operation.promise;
		if (entry.image && Date.now() - entry.checkedAt < REVALIDATE_AFTER_MS) return Promise.resolve();
		const controller = new AbortController();
		const operation = { controller, promise: Promise.resolve() };
		entry.operation = operation;
		operation.promise = this.#load(entry, controller).finally(() => {
			if (entry.operation === operation) entry.operation = null;
		});
		return operation.promise;
	}

	async #load(entry: ImageEntry, controller: AbortController): Promise<void> {
		const { executorId, projectPath, filePath } = entry.target;
		const params = { executorId, projectPath, filePath };
		const options = { signal: controller.signal, cache: 'no-store' } as const;
		const isCurrent = () =>
			this.#isCurrent(entry) &&
			entry.operation?.controller === controller &&
			!controller.signal.aborted;
		let candidateUrl: string | undefined;
		try {
			if (entry.image) {
				const result = await (this.options.getFileRevision ?? getFileRevision)(params, options);
				if (!isCurrent()) return;
				if (result.status === 'missing') {
					this.#drop(entry);
					return;
				}
				if (result.revision === entry.image.revision) {
					entry.checkedAt = Date.now();
					return;
				}
			}
			const { blob, revision } = await (this.options.readContent ?? readContent)(params, options);
			if (!isCurrent()) return;
			if (!blob.type.startsWith('image/'))
				throw new InvalidImageError('Invalid image content type');
			candidateUrl = URL.createObjectURL(blob);
			let dimensions;
			try {
				dimensions = await (this.options.decode ?? decodeFileImage)(
					candidateUrl,
					controller.signal,
				);
			} catch (error) {
				throw new InvalidImageError('Unable to decode image', { cause: error });
			}
			if (!isCurrent()) return;
			const previous = entry.image;
			entry.image = {
				url: candidateUrl,
				revision,
				estimatedBytes: Math.max(
					MIN_IMAGE_BYTES,
					blob.size + dimensions.width * dimensions.height * 4,
				),
			};
			candidateUrl = undefined;
			entry.failed = false;
			entry.checkedAt = Date.now();
			if (previous) {
				await tick();
				URL.revokeObjectURL(previous.url);
			}
		} catch (error) {
			if (!isCurrent()) return;
			if (
				!entry.image ||
				error instanceof InvalidImageError ||
				(error instanceof ApiError &&
					!error.retryable &&
					[400, 403, 404, 413].includes(error.status))
			) {
				this.#drop(entry);
			} else if (!(error instanceof ApiError && error.status === 401)) {
				entry.checkedAt = Date.now();
			}
		} finally {
			if (candidateUrl) URL.revokeObjectURL(candidateUrl);
		}
	}
}
