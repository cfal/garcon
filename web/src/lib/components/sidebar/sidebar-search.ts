// Parses sidebar search queries into structured filter specs and matches
// chats against them. Supports free-text search across title, projectPath,
// firstMessage, lastMessage, and tags, plus structured prefix filters:
// tag:X, provider:Y, model:Z.

export interface ChatFilterSpec {
	textTokens: string[];
	tags: string[];
	providers: string[];
	models: string[];
}

export function emptyFilterSpec(): ChatFilterSpec {
	return { textTokens: [], tags: [], providers: [], models: [] };
}

export function isEmptyFilter(spec: ChatFilterSpec): boolean {
	return (
		spec.textTokens.length === 0 &&
		spec.tags.length === 0 &&
		spec.providers.length === 0 &&
		spec.models.length === 0
	);
}

/** Parses a raw search query into a structured filter spec.
 *  Prefix filters: tag:X, provider:Y, model:Z
 *  Everything else is a free-text token. */
export function parseChatSearch(query: string): ChatFilterSpec {
	const spec = emptyFilterSpec();
	const raw = query.trim();
	if (!raw) return spec;

	// Split on whitespace but preserve quoted strings
	const tokens = tokenize(raw);

	for (const token of tokens) {
		const lower = token.toLowerCase();
		if (lower.startsWith('tag:')) {
			const value = token.slice(4).trim();
			if (value) spec.tags.push(value.toLowerCase());
		} else if (lower.startsWith('provider:')) {
			const value = token.slice(9).trim();
			if (value) spec.providers.push(value.toLowerCase());
		} else if (lower.startsWith('model:')) {
			const value = token.slice(6).trim();
			if (value) spec.models.push(value.toLowerCase());
		} else {
			spec.textTokens.push(lower);
		}
	}

	return spec;
}

/** Splits input on whitespace, keeping "quoted phrases" together. */
function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let inQuote = false;
	let quoteChar = '';

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inQuote) {
			if (ch === quoteChar) {
				inQuote = false;
				if (current) tokens.push(current);
				current = '';
			} else {
				current += ch;
			}
		} else if (ch === '"' || ch === "'") {
			if (current) tokens.push(current);
			current = '';
			inQuote = true;
			quoteChar = ch;
		} else if (ch === ' ' || ch === '\t') {
			if (current) tokens.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Chat-like shape needed for matching. Using a minimal interface
 *  so this module doesn't import ChatSessionRecord directly. */
export interface ChatFilterTarget {
	title: string;
	projectPath: string;
	provider: string;
	model: string | null;
	tags: string[];
	firstMessage?: string;
	lastMessage?: string;
}

/** Checks whether a chat matches a filter spec.
 *  - All text tokens must appear somewhere in the text haystack (AND)
 *  - All tag: filters must be present on the chat (AND)
 *  - Provider filters match any (OR)
 *  - Model filters match any (OR) */
export function matchesChatFilter(chat: ChatFilterTarget, spec: ChatFilterSpec): boolean {
	// Tag filter: chat must have ALL specified tags
	if (spec.tags.length > 0) {
		const chatTags = new Set(chat.tags.map((t) => t.toLowerCase()));
		for (const tag of spec.tags) {
			if (!chatTags.has(tag)) return false;
		}
	}

	// Provider filter: chat must match at least one (OR)
	if (spec.providers.length > 0) {
		const chatProvider = chat.provider.toLowerCase();
		if (!spec.providers.some((p) => chatProvider.includes(p))) return false;
	}

	// Model filter: chat must match at least one (OR)
	if (spec.models.length > 0) {
		const chatModel = (chat.model || '').toLowerCase();
		if (!spec.models.some((m) => chatModel.includes(m))) return false;
	}

	// Text tokens: all must appear somewhere in the haystack (AND)
	if (spec.textTokens.length > 0) {
		const haystack = buildHaystack(chat);
		for (const token of spec.textTokens) {
			if (!haystack.includes(token)) return false;
		}
	}

	return true;
}

function buildHaystack(chat: ChatFilterTarget): string {
	const parts = [
		chat.title,
		chat.projectPath,
		chat.firstMessage || '',
		chat.lastMessage || '',
		...chat.tags,
	];
	return parts.join(' ').toLowerCase();
}
