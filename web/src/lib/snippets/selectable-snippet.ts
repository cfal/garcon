import type { Preamble } from '$shared/preambles';
import { compareSnippetShortNames, type Snippet } from '$shared/snippets';

export type SelectableSnippet =
	| {
			source: 'snippet';
			key: string;
			id: string;
			updatedAt: string;
			shortName: string;
			body: string;
			snippet: Snippet;
	  }
	| {
			source: 'preamble';
			key: string;
			id: string;
			updatedAt: string;
			shortName: string;
			body: string;
			preamble: Preamble;
	  };

export function selectableSnippets(
	snippets: readonly Snippet[],
	preambles: readonly Preamble[],
): SelectableSnippet[] {
	const items: SelectableSnippet[] = snippets.map((snippet) => ({
		source: 'snippet',
		key: `snippet:${snippet.id}`,
		id: snippet.id,
		updatedAt: snippet.updatedAt,
		shortName: snippet.shortName,
		body: snippet.template,
		snippet,
	}));
	for (const preamble of preambles) {
		if (preamble.snippetShortName === undefined) continue;
		items.push({
			source: 'preamble',
			key: `preamble:${preamble.id}`,
			id: preamble.id,
			updatedAt: preamble.updatedAt,
			shortName: preamble.snippetShortName,
			body: preamble.content,
			preamble,
		});
	}
	return items.sort(
		(left, right) =>
			compareSnippetShortNames(left.shortName, right.shortName) ||
			left.key.localeCompare(right.key, 'en'),
	);
}

export function selectableSnippetPreview(item: SelectableSnippet): string {
	return (
		item.body
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? ''
	);
}
