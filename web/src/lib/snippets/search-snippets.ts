/** Ranks exact, prefix, then substring short-name matches. */
export function searchSnippetNames<T extends { shortName: string }>(
	snippets: readonly T[],
	query: string,
): T[] {
	return rankSnippets(snippets, query, null);
}

/** Ranks short-name matches ahead of snippets whose text contains the query. */
export function searchSnippets<T extends { shortName: string }>(
	snippets: readonly T[],
	query: string,
	textFor: (snippet: T) => string,
): T[] {
	return rankSnippets(snippets, query, textFor);
}

function rankSnippets<T extends { shortName: string }>(
	snippets: readonly T[],
	query: string,
	textFor: ((snippet: T) => string) | null,
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
		else if (textFor?.(snippet).toLowerCase().includes(normalized)) textMatches.push(snippet);
	}
	return [...exact, ...prefix, ...contains, ...textMatches];
}
