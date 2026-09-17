import type { SelectableSnippet } from '$lib/snippets/selectable-snippet.js';

export type SnippetInsertionResult = 'inserted' | 'cancelled' | 'failed';

export type SnippetInsertionHandler = (
	snippet: SelectableSnippet,
	argumentsText: string,
) => SnippetInsertionResult | Promise<SnippetInsertionResult>;
