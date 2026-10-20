import { walkTokens, type MarkedExtension, type Token, type Tokens } from 'marked';

function containsOnlyImages(tokens: Token[] = []): boolean {
	const content = tokens.filter(
		(token) => token.type !== 'br' && !(token.type === 'text' && !token.text.trim()),
	);
	return (
		content.length > 0 &&
		content.every((token) => {
			switch (token.type) {
				case 'image':
					return true;
				case 'link':
				case 'em':
				case 'strong':
				case 'del':
					return containsOnlyImages(token.tokens);
				default:
					return false;
			}
		})
	);
}

export function createImageParagraphMarkdownExtension(): MarkedExtension {
	return {
		walkTokens(token) {
			// Svelte Markdown's synchronous parser invokes this hook only for root tokens.
			walkTokens([token], (child) => {
				if (child.type !== 'paragraph') return;
				const paragraph = child as Tokens.Paragraph & { imageOnly: boolean };
				paragraph.imageOnly = containsOnlyImages(paragraph.tokens);
			});
		},
	};
}
