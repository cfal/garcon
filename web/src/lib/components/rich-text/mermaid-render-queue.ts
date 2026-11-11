import type { RendererThemeId } from '$lib/theme/themes';

export const MERMAID_SOURCE_LIMIT = 50_000;
export const MERMAID_OUTPUT_LIMIT = 1_000_000;
export const MERMAID_CACHE_BYTE_LIMIT = 4 * 1024 * 1024;
const MERMAID_CACHE_ENTRY_LIMIT = 64;

interface RenderConsumer {
	resolve: (svg: string) => void;
	reject: (error: unknown) => void;
	cleanup: () => void;
}

interface RenderJob {
	key: string;
	source: string;
	theme: RendererThemeId;
	controller: AbortController;
	consumers: Set<RenderConsumer>;
}

type RenderDiagram = (
	source: string,
	theme: RendererThemeId,
	signal: AbortSignal,
) => Promise<string>;

export class MermaidRenderQueue {
	readonly #cache = new Map<string, { svg: string; bytes: number }>();
	readonly #jobs = new Map<string, RenderJob>();
	readonly #pending: RenderJob[] = [];
	#cacheBytes = 0;
	#running = false;

	constructor(private readonly renderDiagram: RenderDiagram) {}

	render(source: string, theme: RendererThemeId, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (source.length > MERMAID_SOURCE_LIMIT)
			return Promise.reject(new Error('Diagram source is too large to render'));
		const key = `${theme}\0${source}`;
		const cached = this.#cache.get(key);
		if (cached) {
			this.#cache.delete(key);
			this.#cache.set(key, cached);
			return Promise.resolve(cached.svg);
		}
		let job = this.#jobs.get(key);
		if (!job) {
			job = { key, source, theme, controller: new AbortController(), consumers: new Set() };
			this.#jobs.set(key, job);
			this.#pending.push(job);
		}
		const requestedJob = job;
		const promise = new Promise<string>((resolve, reject) => {
			const onAbort = () => {
				consumer.cleanup();
				requestedJob.consumers.delete(consumer);
				reject(signal?.reason);
				if (requestedJob.consumers.size === 0) this.#cancel(requestedJob);
			};
			const consumer: RenderConsumer = {
				resolve,
				reject,
				cleanup: () => signal?.removeEventListener('abort', onAbort),
			};
			requestedJob.consumers.add(consumer);
			signal?.addEventListener('abort', onAbort, { once: true });
		});
		this.#startNext();
		return promise;
	}

	#cancel(job: RenderJob): void {
		job.controller.abort();
		if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
		const index = this.#pending.indexOf(job);
		if (index !== -1) this.#pending.splice(index, 1);
	}

	#startNext(): void {
		if (this.#running) return;
		const job = this.#pending.shift();
		if (!job) return;
		this.#running = true;
		void this.#run(job);
	}

	async #run(job: RenderJob): Promise<void> {
		try {
			const svg = await this.renderDiagram(job.source, job.theme, job.controller.signal);
			if (job.controller.signal.aborted) return;
			if (svg.length > MERMAID_OUTPUT_LIMIT) throw new Error('Rendered diagram is too large');
			this.#cacheResult(job.key, svg);
			for (const consumer of job.consumers) consumer.resolve(svg);
		} catch (error) {
			for (const consumer of job.consumers) consumer.reject(error);
		} finally {
			for (const consumer of job.consumers) consumer.cleanup();
			job.consumers.clear();
			if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
			this.#running = false;
			this.#startNext();
		}
	}

	#cacheResult(key: string, svg: string): void {
		const bytes = (key.length + svg.length) * 2;
		if (bytes > MERMAID_CACHE_BYTE_LIMIT) return;
		while (
			this.#cache.size >= MERMAID_CACHE_ENTRY_LIMIT ||
			this.#cacheBytes + bytes > MERMAID_CACHE_BYTE_LIMIT
		) {
			const oldest = this.#cache.keys().next().value;
			if (oldest === undefined) break;
			this.#cacheBytes -= this.#cache.get(oldest)!.bytes;
			this.#cache.delete(oldest);
		}
		this.#cache.set(key, { svg, bytes });
		this.#cacheBytes += bytes;
	}
}
