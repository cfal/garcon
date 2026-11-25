export function storeMostRecent<V>(
	entries: Map<string, V>,
	key: string,
	value: V,
	limit: number,
): void {
	entries.delete(key);
	entries.set(key, value);
	while (entries.size > limit) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) break;
		entries.delete(oldest);
	}
}

export function takeMostRecent<V>(entries: Map<string, V>, key: string): V | null {
	const value = entries.get(key);
	if (value === undefined) return null;
	entries.delete(key);
	entries.set(key, value);
	return value;
}
