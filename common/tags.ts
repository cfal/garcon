// Shared tag normalization helpers for chat-tagging UI and server routes.

export function normalizeTagSlug(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-{2,}/g, '-')
		.replace(/^-|-$/g, '');
}

export function appendNormalizedUniqueTag(tags: string[], rawTag: string): string[] {
	const normalized = normalizeTagSlug(rawTag);
	if (!normalized) return tags;
	if (tags.some((tag) => tag.toLowerCase() === normalized)) return tags;
	return [...tags, normalized];
}

export function finalizeNormalizedTags(tags: string[], pendingTag: string): string[] {
	return appendNormalizedUniqueTag(tags, pendingTag);
}

export function normalizeTags(raw: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const item of raw) {
		if (typeof item !== 'string') continue;
		const tag = normalizeTagSlug(item);
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		normalized.push(tag);
	}
	return normalized.sort();
}
