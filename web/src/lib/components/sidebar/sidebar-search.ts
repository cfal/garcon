// Parses sidebar search queries into structured filter specs and matches
// chats against them. Supports free-text search across title, projectPath,
// firstMessage, lastMessage, and tags, plus structured prefix filters:
// tag:X, agent:Y, model:Z, project:P. The | character creates OR groups
// within an operator, e.g. tag:a|b matches chats with tag "a" or "b".

/** An OR group — values within one group match if ANY element matches. */
type OrGroup = string[];

export interface ChatFilterSpec {
	textTokens: string[];
	tags: OrGroup[];        // Each group is OR'd; groups are AND'd together
	agents: string[];      // OR across all values
	models: string[];         // OR across all values
	status?: 'active' | 'unread';
	project: string[];      // OR across all values
}

export function emptyFilterSpec(): ChatFilterSpec {
	return { textTokens: [], tags: [], agents: [], models: [], project: [] };
}

export function isEmptyFilter(spec: ChatFilterSpec): boolean {
	return (
		spec.textTokens.length === 0 &&
		spec.tags.length === 0 &&
		spec.agents.length === 0 &&
		spec.models.length === 0 &&
		spec.status === undefined &&
		spec.project.length === 0
	);
}

/** Splits a pipe-delimited value into non-empty, lowercased parts.
 *  Returns null if all parts are empty after splitting. */
function parsePipeValue(raw: string): string[] | null {
	const parts = raw.split('|')
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);
	return parts.length > 0 ? parts : null;
}

/** Parses a raw search query into a structured filter spec.
 *  Prefix filters: tag:X, agent:Y, model:Z, project:P
 *  The | character creates OR groups within a single operator value.
 *  Everything else is a free-text token. */
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
			if (!value) continue;
			const parts = parsePipeValue(value);
			if (parts) spec.tags.push(parts);
		} else if (lower.startsWith('agent:')) {
			const value = token.slice(6).trim();
			if (!value) continue;
			const parts = parsePipeValue(value);
			if (parts) spec.agents.push(...parts);
		} else if (lower.startsWith('model:')) {
			const value = token.slice(6).trim();
			if (!value) continue;
			const parts = parsePipeValue(value);
			if (parts) spec.models.push(...parts);
		} else if (lower.startsWith('project:')) {
			const value = token.slice(8).trim();
			if (!value) continue;
			const parts = parsePipeValue(value);
			if (parts) spec.project.push(...parts);
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
	agentId: string;
	model: string | null;
	tags: string[];
	isProcessing: boolean;
	isUnread: boolean;
	firstMessage?: string;
	lastMessage?: string;
}

/** Checks whether a chat matches a filter spec.
 *  - All text tokens must appear somewhere in the text haystack (AND)
 *  - Each tag OR group must have at least one match; groups are AND'd (AND)
 *  - Agent filters match any (OR)
 *  - Model filters match any (OR)
 *  - Project filters match any value as substring (OR) */
export function matchesChatFilter(chat: ChatFilterTarget, spec: ChatFilterSpec): boolean {
	if (spec.status === 'active' && !chat.isProcessing) return false;
	if (spec.status === 'unread' && !chat.isUnread) return false;

	// Project filter: projectPath must contain at least one value (OR)
	if (spec.project.length > 0) {
		const chatPath = chat.projectPath.toLowerCase();
		if (!spec.project.some((p) => chatPath.includes(p))) return false;
	}

	// Tag filter: each OR group must have at least one match
	if (spec.tags.length > 0) {
		const chatTags = new Set(chat.tags.map((t) => t.toLowerCase()));
		for (const group of spec.tags) {
			if (!group.some((tag) => chatTags.has(tag))) return false;
		}
	}

	// Agent filter: chat must match at least one (OR)
	if (spec.agents.length > 0) {
		const chatAgent = chat.agentId.toLowerCase();
		if (!spec.agents.some((agent) => chatAgent.includes(agent))) return false;
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
	for (const group of spec.tags) {
		parts.push(`tag:${group.join('|')}`);
	}
	for (const agent of spec.agents) parts.push(`agent:${agent}`);
	for (const model of spec.models) parts.push(`model:${model}`);
	if (spec.project.length > 0) {
		parts.push(`project:${spec.project.join('|')}`);
	}
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
	const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`\\btag:${escaped}\\b`, 'gi');
	return query.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
}

/** Checks if a query already contains a specific tag filter. */
export function queryHasTag(query: string, tag: string): boolean {
	const spec = parseChatSearch(query);
	return spec.tags.some((group) => group.includes(tag.toLowerCase()));
}
