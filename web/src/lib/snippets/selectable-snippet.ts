import type { Preamble } from '$shared/preambles';
import {
	compareSnippetShortNames,
	type ExpandSnippetResponse,
	type Snippet,
} from '$shared/snippets';
import { snippetPreview } from '$lib/snippets/snippet-presentation.js';

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

export function snippetToSelectable(
	snippet: Snippet,
): Extract<SelectableSnippet, { source: 'snippet' }> {
	return {
		source: 'snippet',
		key: `snippet:${snippet.id}`,
		id: snippet.id,
		updatedAt: snippet.updatedAt,
		shortName: snippet.shortName,
		body: snippet.template,
		snippet,
	};
}

export function preambleToSelectable(
	preamble: Preamble,
): Extract<SelectableSnippet, { source: 'preamble' }> | null {
	if (preamble.snippetShortName === undefined) return null;
	return {
		source: 'preamble',
		key: `preamble:${preamble.id}`,
		id: preamble.id,
		updatedAt: preamble.updatedAt,
		shortName: preamble.snippetShortName,
		body: preamble.content,
		preamble,
	};
}

export function selectableSnippets(
	snippets: readonly Snippet[],
	preambles: readonly Preamble[],
): SelectableSnippet[] {
	const items: SelectableSnippet[] = snippets.map(snippetToSelectable);
	for (const preamble of preambles) {
		const item = preambleToSelectable(preamble);
		if (item) items.push(item);
	}
	return items.sort(
		(left, right) =>
			compareSnippetShortNames(left.shortName, right.shortName) ||
			left.key.localeCompare(right.key, 'en'),
	);
}

export function selectableSnippetPreview(item: SelectableSnippet): string {
	return snippetPreview({ template: item.body });
}

export function matchesSelectableSnippetExpansion(
	item: SelectableSnippet,
	response: Pick<ExpandSnippetResponse, 'source' | 'sourceId' | 'sourceUpdatedAt'>,
): boolean {
	return (
		response.source === item.source &&
		response.sourceId === item.id &&
		response.sourceUpdatedAt === item.updatedAt
	);
}

export function mismatchedSnippetSources(
	item: SelectableSnippet,
	response: Pick<ExpandSnippetResponse, 'source' | 'sourceId' | 'sourceUpdatedAt'>,
): SelectableSnippet['source'][] {
	if (matchesSelectableSnippetExpansion(item, response)) return [];
	return response.source === item.source ? [item.source] : [item.source, response.source];
}
