import { Lexer, type MarkedExtension, type TokenizerExtension } from 'marked';

// Shares svelte-markdown's Marked range so this regex tracks the active lexer.
const INLINE_HTML_TAG = Lexer.rules.inline.gfm.tag;
// Mirrors Marked's inline comment alternative and omits block EOF/tail matching so
// unterminated comments and same-line trailing text remain visible.
const HTML_COMMENT = /^ {0,3}<!--(?:-?>|[\s\S]*?-->)/;

const literalHtmlTextTokenizer: TokenizerExtension = {
	// Routes literal tags through Marked's built-in text renderer.
	name: 'text',
	level: 'inline',
	tokenizer(source) {
		if (HTML_COMMENT.test(source)) return;

		const match = INLINE_HTML_TAG.exec(source);
		if (!match) return;

		return {
			type: 'text',
			raw: match[0],
			text: match[0],
		};
	},
};

/** Treats Markdown raw HTML as literal source text while preserving comment semantics. */
export function createLiteralHtmlMarkdownExtension(): MarkedExtension {
	return {
		extensions: [literalHtmlTextTokenizer],
		tokenizer: {
			html(source) {
				const comment = HTML_COMMENT.exec(source);
				if (comment) {
					return {
						type: 'html',
						raw: comment[0],
						text: comment[0],
						block: true,
						pre: false,
					};
				}

				return undefined;
			},
		},
	};
}
