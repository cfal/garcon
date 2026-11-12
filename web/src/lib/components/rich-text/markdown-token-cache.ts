import { tokenCache } from '@humanspeak/svelte-markdown';

export const MARKDOWN_TOKEN_CACHE_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_ESTIMATED_TOKEN_VALUES = 20_000;
const tokenBytes = new WeakMap<object, number>();
let scheduled = false;

function estimateTokenBytes(tokens: object): number {
	const known = tokenBytes.get(tokens);
	if (known !== undefined) return known;
	const pending: unknown[] = [tokens];
	const seen = new Set<object>();
	let bytes = 0;
	let remaining = MAX_ESTIMATED_TOKEN_VALUES;
	while (pending.length > 0) {
		if (--remaining < 0 || bytes > MARKDOWN_TOKEN_CACHE_BYTE_LIMIT) {
			bytes = Infinity;
			break;
		}
		const value = pending.pop();
		if (typeof value === 'string') bytes += value.length * 2;
		else if (value !== null && typeof value === 'object' && !seen.has(value)) {
			seen.add(value);
			const values = Array.isArray(value) ? value : Object.values(value);
			if (values.length + pending.length > remaining) {
				bytes = Infinity;
				break;
			}
			bytes += 64 + values.length * 8;
			for (const child of values) pending.push(child);
		}
	}
	tokenBytes.set(tokens, bytes);
	return bytes;
}

export function trimMarkdownTokenCache(
	cache: Pick<typeof tokenCache, 'entries' | 'delete'> = tokenCache,
): void {
	let retainedBytes = 0;
	for (const [key, entry] of cache.entries().reverse()) {
		if (!entry) continue;
		const sourceBytes = entry.source.length * 2;
		const bytes =
			sourceBytes > MARKDOWN_TOKEN_CACHE_BYTE_LIMIT
				? Infinity
				: sourceBytes + estimateTokenBytes(entry.tokens);
		if (retainedBytes + bytes > MARKDOWN_TOKEN_CACHE_BYTE_LIMIT) cache.delete(key);
		else retainedBytes += bytes;
	}
}

export function scheduleMarkdownTokenCacheTrim(): void {
	if (scheduled) return;
	scheduled = true;
	queueMicrotask(() => {
		scheduled = false;
		trimMarkdownTokenCache();
	});
}
