// The Markdown serializer backslash-escapes or entity-encodes every one of these characters in
// text, which turns `my_var`, `<tag>`, and `C:\dir` into `my\_var`, `&lt;tag&gt;`, and `C:\\dir`
// in the prompt. Characters that cannot change the parse are swapped for private-use sentinels
// before serialization and restored afterwards, so only the ambiguous ones stay escaped.
const SPECIAL_CHARACTERS = '\\`*_[]~&<>';
// The serializer would write these as character references, which the draft parser leaves as
// written. They take a backslash instead where they cannot stay bare.
const BACKSLASH_ESCAPED = '<>';
const PRIVATE_USE_START = 0xe000;
const PRIVATE_USE_END = 0xf8ff;

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const AUTOLINK = /^<(?:[a-z][a-z0-9+.-]{1,31}:|[^\s<>@]+@)/i;
const LINK_CLOSE = /^\[[^\]]*\][([:]/;
const TASK_MARKER = /^\[[ xX]\](?:\s|$)/;

export interface TextContext {
	/** The text begins a line, where `>`, `*`, and task markers open a block. */
	lineStart: boolean;
	/** The text is a link label, where brackets end the label. */
	link: boolean;
}

function staysLiteral(text: string, index: number, context: TextContext): boolean {
	const previous = text[index - 1];
	const next = text[index + 1];
	const rest = text.slice(index);
	const leading = context.lineStart && text.slice(0, index).trim() === '';
	switch (text[index]) {
		case '\\':
			// A backslash escapes only ASCII punctuation; a trailing one may meet it in the next node.
			return next !== undefined && !ASCII_PUNCTUATION.test(next);
		case '*':
			if (leading || previous === undefined || next === undefined) return false;
			return /\s/.test(previous) && /\s/.test(next);
		case '_':
			if (previous === undefined || next === undefined) return false;
			return (
				(WORD_CHARACTER.test(previous) && WORD_CHARACTER.test(next)) ||
				(/\s/.test(previous) && /\s/.test(next))
			);
		case '~':
			return text.indexOf('~') === text.lastIndexOf('~');
		case '[':
			if (context.link || (leading && TASK_MARKER.test(rest))) return false;
			return !LINK_CLOSE.test(rest);
		case ']':
			return !context.link;
		case '&':
			// The draft parser leaves character references as written, so none needs an escape.
			return true;
		case '<':
			return !AUTOLINK.test(rest);
		case '>':
			return !leading;
		default:
			return false;
	}
}

export interface TextProtection {
	/** Protects every special character, for text the serializer must emit verbatim. */
	verbatim(text: string): string;
	/** Protects the special characters in prose that read the same without an escape. */
	prose(text: string, context: TextContext): string;
	restore(markdown: string): string;
}

/**
 * Picks sentinels the draft does not use. Returns null when the draft occupies the whole
 * private-use area, in which case the serializer's own escaping applies unchanged.
 */
export function createTextProtection(draftText: string): TextProtection | null {
	const used = new Set<number>();
	for (let index = 0; index < draftText.length; index += 1) {
		const unit = draftText.charCodeAt(index);
		if (unit >= PRIVATE_USE_START && unit <= PRIVATE_USE_END) used.add(unit);
	}
	const width = SPECIAL_CHARACTERS.length + BACKSLASH_ESCAPED.length;
	let base = PRIVATE_USE_START;
	const occupied = (start: number) => {
		for (let offset = 0; offset < width; offset += 1) if (used.has(start + offset)) return true;
		return false;
	};
	while (base + width - 1 <= PRIVATE_USE_END && occupied(base)) base += width;
	if (base + width - 1 > PRIVATE_USE_END) return null;

	const sentinel = (character: string) =>
		String.fromCharCode(base + SPECIAL_CHARACTERS.indexOf(character));
	const sentinels = new RegExp(
		`[\\u${base.toString(16)}-\\u${(base + width - 1).toString(16)}]`,
		'g',
	);
	const escaped = (character: string) =>
		String.fromCharCode(base + SPECIAL_CHARACTERS.length + BACKSLASH_ESCAPED.indexOf(character));
	const protect = (text: string, literal: (index: number) => boolean) => {
		let output = '';
		for (let index = 0; index < text.length; index += 1) {
			const character = text[index];
			if (!SPECIAL_CHARACTERS.includes(character)) output += character;
			else if (literal(index)) output += sentinel(character);
			else output += BACKSLASH_ESCAPED.includes(character) ? escaped(character) : character;
		}
		return output;
	};
	return {
		verbatim: (text) => protect(text, () => true),
		prose: (text, context) => protect(text, (index) => staysLiteral(text, index, context)),
		restore: (markdown) =>
			markdown.replace(sentinels, (character) => {
				const index = character.charCodeAt(0) - base;
				return index < SPECIAL_CHARACTERS.length
					? SPECIAL_CHARACTERS.charAt(index)
					: `\\${BACKSLASH_ESCAPED.charAt(index - SPECIAL_CHARACTERS.length)}`;
			}),
	};
}
