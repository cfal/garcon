const MAX_IMAGE_LOADS = 4;
const MAX_PENDING_IMAGE_LOADS = 64;

interface ImageLoad {
	start: () => Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
	cleanup: () => void;
}

export class FileImageLoadQueue {
	#active = 0;
	readonly #pending: ImageLoad[] = [];

	run(start: () => Promise<void>, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(signal.reason);
		if (this.#pending.length >= MAX_PENDING_IMAGE_LOADS)
			return Promise.reject(new Error('Image loading queue is full'));
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				const index = this.#pending.indexOf(job);
				if (index !== -1) this.#pending.splice(index, 1);
				job.cleanup();
				reject(signal.reason);
			};
			const job: ImageLoad = {
				start,
				resolve,
				reject,
				cleanup: () => signal.removeEventListener('abort', onAbort),
			};
			signal.addEventListener('abort', onAbort, { once: true });
			this.#pending.push(job);
			this.#drain();
		});
	}

	#drain(): void {
		while (this.#active < MAX_IMAGE_LOADS && this.#pending.length) {
			const job = this.#pending.shift()!;
			job.cleanup();
			this.#active++;
			void this.#load(job);
		}
	}

	async #load(job: ImageLoad): Promise<void> {
		try {
			await job.start();
			job.resolve();
		} catch (error) {
			job.reject(error);
		} finally {
			this.#active--;
			this.#drain();
		}
	}
}
