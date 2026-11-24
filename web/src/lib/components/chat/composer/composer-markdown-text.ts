import type { JSONContent } from '@tiptap/core';

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
const TASK_MARKER = /^\[[ xX]\](?:\s|$)/;

/** Scans repeated mark attributes once per pass without expanding them into JSON strings. */
export class MarkdownPrivateUseCharacters {
	readonly used = new Set<number>();
	#strings = new Map<string, boolean>();
	#objects = new WeakMap<object, boolean>();

	scan(value: unknown): boolean {
		if (typeof value === 'string') {
			const cached = this.#strings.get(value);
			if (cached !== undefined) return cached;
			let found = false;
			for (let index = 0; index < value.length; index++) {
				const unit = value.charCodeAt(index);
				if (unit >= PRIVATE_USE_START && unit <= PRIVATE_USE_END) {
					this.used.add(unit);
					found = true;
				}
			}
			this.#strings.set(value, found);
			return found;
		}
		if (value === null || typeof value !== 'object') return false;
		const cached = this.#objects.get(value);
		if (cached !== undefined) return cached;
		let found = false;
		for (const child of Object.values(value)) {
			if (this.scan(child)) found = true;
		}
		this.#objects.set(value, found);
		return found;
	}
}

export interface TextContext {
	/** The text begins a line, where `>`, `*`, and task markers open a block. */
	lineStart: boolean;
	/** The text is a link label, where brackets end the label. */
	link: boolean;
}

function literalProseAt(text: string, context: TextContext): (index: number) => boolean {
	const leading = context.lineStart ? text.search(/\S/) : -1;
	let close = -1;
	return (index) => {
		const previous = text[index - 1];
		const next = text[index + 1];
		switch (text[index]) {
			case '\\':
				// A backslash escapes only ASCII punctuation; a trailing one may meet it in the next node.
				return next !== undefined && !ASCII_PUNCTUATION.test(next);
			case '*':
				if (index === leading || previous === undefined || next === undefined) return false;
				return /\s/.test(previous) && /\s/.test(next);
			case '_':
				if (previous === undefined || next === undefined) return false;
				return (
					(WORD_CHARACTER.test(previous) && WORD_CHARACTER.test(next)) ||
					(/\s/.test(previous) && /\s/.test(next))
				);
			case '~':
				return text.indexOf('~', index + 1) === -1 && text.indexOf('~') === index;
			case '[': {
				if (context.link || (index === leading && TASK_MARKER.test(text.slice(index)))) return false;
				// Nested or unfinished labels share the same next `]` as protection moves forward.
				if (index > close) {
					close = text.indexOf(']', index + 1);
					if (close === -1) close = text.length;
				}
				const after = text[close + 1];
				return after !== '(' && after !== '[' && after !== ':';
			}
			case ']':
				return !context.link;
			case '&':
				// The draft parser leaves character references as written, so none needs an escape.
				return true;
			case '<':
				return !AUTOLINK.test(text.slice(index));
			case '>':
				return index !== leading;
			default:
				return false;
		}
	};
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
export function createTextProtection(draft: JSONContent | string): TextProtection | null {
	const characters = new MarkdownPrivateUseCharacters();
	characters.scan(draft);
	const width = SPECIAL_CHARACTERS.length + BACKSLASH_ESCAPED.length;
	let base = PRIVATE_USE_START;
	const occupied = (start: number) => {
		for (let offset = 0; offset < width; offset += 1) if (characters.used.has(start + offset)) return true;
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
		prose: (text, context) => protect(text, literalProseAt(text, context)),
		restore: (markdown) =>
			markdown.replace(sentinels, (character) => {
				const index = character.charCodeAt(0) - base;
				return index < SPECIAL_CHARACTERS.length
					? SPECIAL_CHARACTERS.charAt(index)
					: `\\${BACKSLASH_ESCAPED.charAt(index - SPECIAL_CHARACTERS.length)}`;
			}),
	};
}
