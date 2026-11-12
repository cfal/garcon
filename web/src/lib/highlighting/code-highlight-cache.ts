import type { CodeHighlightSegment } from './code-highlight-types';

export class CodeHighlightCache {
	#entries = new Map<string, { segments: CodeHighlightSegment[]; bytes: number }>();
	#bytes = 0;

	constructor(private readonly maxBytes = 2 * 1024 * 1024, private readonly maxEntries = 32) {}

	get(key: string): CodeHighlightSegment[] | undefined {
		const entry = this.#entries.get(key);
		if (!entry) return;
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		return entry.segments;
	}

	set(key: string, segments: CodeHighlightSegment[]): void {
		const bytes = key.length * 2 + segments.reduce(
			(total, segment) => total + segment.text.length * 2 + (segment.className?.length ?? 0) * 2 + 64,
			0,
		);
		if (bytes > this.maxBytes || this.maxEntries < 1) return;
		this.#bytes -= this.#entries.get(key)?.bytes ?? 0;
		this.#entries.delete(key);
		this.#entries.set(key, { segments, bytes });
		this.#bytes += bytes;
		while (this.#entries.size > this.maxEntries || this.#bytes > this.maxBytes) {
			const oldest = this.#entries.keys().next().value!;
			this.#bytes -= this.#entries.get(oldest)!.bytes;
			this.#entries.delete(oldest);
		}
	}
}
