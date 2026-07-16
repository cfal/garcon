import type { Snippet } from '$shared/snippets';

export type SnippetInsertionResult = 'inserted' | 'cancelled' | 'failed';

export type SnippetInsertionHandler = (
	snippet: Snippet,
	argumentsText: string,
) => SnippetInsertionResult | Promise<SnippetInsertionResult>;
