// Parses sidebar search queries into structured filter specs and matches
// chats against them. Supports free-text search across title, projectPath,
// firstMessage, lastMessage, and tags, plus structured prefix filters:
// tag:X, provider:Y, model:Z, project:P.

export interface ChatFilterSpec {
	textTokens: string[];
	tags: string[];
	providers: string[];
	models: string[];
	status?: 'active' | 'unread';
	project: string | null;
}

export function emptyFilterSpec(): ChatFilterSpec {
	return { textTokens: [], tags: [], providers: [], models: [], project: null };
}

export function isEmptyFilter(spec: ChatFilterSpec): boolean {
	return (
		spec.textTokens.length === 0 &&
		spec.tags.length === 0 &&
		spec.providers.length === 0 &&
		spec.models.length === 0 &&
		spec.status === undefined &&
		spec.project === null
	);
}

/** Sentinel value set when multiple project: filters are parsed.
 *  No real path can contain this, so matches always fail. */
const MULTI_PROJECT_SENTINEL = '\0MULTI\0';

/** Parses a raw search query into a structured filter spec.
 *  Prefix filters: tag:X, provider:Y, model:Z, project:P
 *  Everything else is a free-text token.
 *  Multiple project: filters are invalid and set project to a sentinel
 *  that matches no chats. */
export function parseChatSearch(query: string): ChatFilterSpec {
	const spec = emptyFilterSpec();
	const raw = query.trim();
	if (!raw) return spec;

	// Split on whitespace but preserve quoted strings
	const tokens = tokenize(raw);

	for (const token of tokens) {
		const lower = token.toLowerCase();
		if (lower.startsWith('status:')) {
			const value = token.slice(7).trim().toLowerCase();
			if (value === 'active' || value === 'unread') {
				spec.status = value;
			}
		} else if (lower.startsWith('tag:')) {
			const value = token.slice(4).trim();
			if (value) spec.tags.push(value.toLowerCase());
		} else if (lower.startsWith('provider:')) {
			const value = token.slice(9).trim();
			if (value) spec.providers.push(value.toLowerCase());
		} else if (lower.startsWith('model:')) {
			const value = token.slice(6).trim();
			if (value) spec.models.push(value.toLowerCase());
		} else if (lower.startsWith('project:')) {
			const value = token.slice(8).trim();
			if (!value) continue;
			if (spec.project !== null) {
				// Multiple project: filters are invalid — mark as no-match
				spec.project = MULTI_PROJECT_SENTINEL;
			} else {
				spec.project = value.toLowerCase();
			}
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
	isProcessing: boolean;
	isUnread: boolean;
	firstMessage?: string;
	lastMessage?: string;
}

/** Checks whether a chat matches a filter spec.
 *  - All text tokens must appear somewhere in the text haystack (AND)
 *  - All tag: filters must be present on the chat (AND)
 *  - Provider filters match any (OR)
 *  - Model filters match any (OR)
 *  - Project filter checks substring match against projectPath */
export function matchesChatFilter(chat: ChatFilterTarget, spec: ChatFilterSpec): boolean {
	if (spec.status === 'active' && !chat.isProcessing) return false;
	if (spec.status === 'unread' && !chat.isUnread) return false;

	// Project filter: projectPath must contain the value (case-insensitive)
	if (spec.project !== null) {
		if (!chat.projectPath.toLowerCase().includes(spec.project)) return false;
	}

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

/** Serializes a ChatFilterSpec back into a search query string. */
export function serializeChatFilter(spec: ChatFilterSpec): string {
	const parts: string[] = [];
	if (spec.status) parts.push(`status:${spec.status}`);
	for (const tag of spec.tags) parts.push(`tag:${tag}`);
	for (const provider of spec.providers) parts.push(`provider:${provider}`);
	for (const model of spec.models) parts.push(`model:${model}`);
	if (spec.project !== null) parts.push(`project:${spec.project}`);
	for (const text of spec.textTokens) {
		parts.push(text.includes(' ') ? `"${text}"` : text);
	}
	return parts.join(' ');
}

/** Adds a tag filter to the current search query without duplicating. */
export function addTagToQuery(query: string, tag: string): string {
	if (queryHasTag(query, tag)) return query;
	const prefix = query.trim();
	return prefix ? `${prefix} tag:${tag}` : `tag:${tag}`;
}

/** Removes a tag filter from the current search query. */
export function removeTagFromQuery(query: string, tag: string): string {
	const pattern = new RegExp(`\\btag:${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
	return query.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
}

/** Checks if a query already contains a specific tag filter. */
export function queryHasTag(query: string, tag: string): boolean {
	const spec = parseChatSearch(query);
	return spec.tags.includes(tag.toLowerCase());
}
