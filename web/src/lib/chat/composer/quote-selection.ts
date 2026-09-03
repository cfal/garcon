/** Formats selected text as a markdown blockquote block for insertion into a chat draft. */
export function formatQuoteBlock(text: string): string {
	if (!text.trim()) return '';
	const normalized = text.replace(/\r\n?/g, '\n');
	return `${normalized
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n')}\n\n`;
}
