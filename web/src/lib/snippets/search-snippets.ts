export function searchSnippets<T extends { shortName: string }>(
	snippets: readonly T[],
	query: string,
	textFor: (snippet: T) => string,
): T[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return [...snippets];
	const exact: T[] = [];
	const prefix: T[] = [];
	const contains: T[] = [];
	const textMatches: T[] = [];
	for (const snippet of snippets) {
		const name = snippet.shortName.toLowerCase();
		if (name === normalized) exact.push(snippet);
		else if (name.startsWith(normalized)) prefix.push(snippet);
		else if (name.includes(normalized)) contains.push(snippet);
		else if (textFor(snippet).toLowerCase().includes(normalized)) textMatches.push(snippet);
	}
	return [...exact, ...prefix, ...contains, ...textMatches];
}
