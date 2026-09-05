import { CHAT_ID_LENGTH, parseChatId } from '$shared/chat-id.js';
import type { MarkedExtension, TokenizerExtension } from 'marked';

const WORD_CHARACTER = /[\p{L}\p{M}\p{N}_]/u;
const CHAT_ID_AT_START = new RegExp(
	`^(\\d{${CHAT_ID_LENGTH}})(?![\\p{L}\\p{M}\\p{N}_]|@[\\p{L}\\p{N}])`,
	'u',
);
const CHAT_ID_AHEAD = new RegExp(
	`\\d{${CHAT_ID_LENGTH}}(?![\\p{L}\\p{M}\\p{N}_]|@[\\p{L}\\p{N}])`,
	'u',
);

const chatReferenceTokenizer: TokenizerExtension = {
	name: 'chatReference',
	level: 'inline',
	start(source) {
		if (this.lexer.state.inLink) return;
		return source.search(CHAT_ID_AHEAD);
	},
	tokenizer(source, tokens) {
		if (this.lexer.state.inLink) return;
		const match = CHAT_ID_AT_START.exec(source);
		if (!match) return;

		const previousRaw = tokens.at(-1)?.raw ?? '';
		const previousCharacter = [...previousRaw.slice(-2)].at(-1);
		if (previousCharacter && WORD_CHARACTER.test(previousCharacter)) return;

		try {
			const chatId = parseChatId(match[1]);
			return {
				type: 'chatReference',
				raw: chatId,
				chatId,
			};
		} catch {
			return;
		}
	},
};

export function createChatReferenceMarkdownExtension(): MarkedExtension {
	return { extensions: [chatReferenceTokenizer] };
}
