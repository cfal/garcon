import type { Snippet } from '$shared/snippets';

export function snippetPreview(snippet: Pick<Snippet, 'template'>): string {
	return (
		snippet.template
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? ''
	);
}
