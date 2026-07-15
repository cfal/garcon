// Pure helper functions for tool display formatting. Extracted from
// the monolithic tool-renderers module for testability and reuse.

import * as m from '$lib/paraglide/messages.js';
import type { ToolPayload } from '$lib/chat/tools/tool-display-contract.js';

/** Coerces a value to a finite number, returning null when not representable. */
export function asFiniteNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/** Formats a human-readable line range string from Read tool input. */
export function readRangePresenter(input: ToolPayload): string | undefined {
	const offset = asFiniteNumber(input.offset ?? input.startLine);
	const limit = asFiniteNumber(input.limit ?? input.numLines);
	const endLine = asFiniteNumber(input.endLine);

	if (offset !== null && limit !== null && limit > 0) {
		const start = Math.max(1, Math.trunc(offset));
		const count = Math.max(1, Math.trunc(limit));
		const end = start + count - 1;
		return `Lines ${start}-${end}`;
	}
	if (offset !== null && endLine !== null) {
		const start = Math.max(1, Math.trunc(offset));
		const end = Math.max(start, Math.trunc(endLine));
		return `Lines ${start}-${end}`;
	}
	if (offset !== null) {
		return `From line ${Math.max(1, Math.trunc(offset))}`;
	}
	if (limit !== null && limit > 0) {
		return `Up to ${Math.max(1, Math.trunc(limit))} lines`;
	}

	return undefined;
}

/** Formats instruction text from WebFetch tool input. */
export function webFetchSecondaryPresenter(input: ToolPayload): string | undefined {
	const prompt = String(input.prompt ?? '').trim();
	if (!prompt) return undefined;
	return `${m.chat_tool_web_fetch_instruction()}: ${prompt}`;
}

/** Extracts a displayable string from normalized tool-result content.
 * Content is always Record<string, any> from normalizeToolResultContent:
 * { raw: string } for plain strings, { items: [...] } for arrays, or
 * arbitrary object keys for structured data. */
export function extractContentString(content: unknown): string {
	if (!content || typeof content !== 'object') return '';
	const rec = content as Record<string, unknown>;
	if (typeof rec.raw === 'string') return rec.raw;
	const keys = Object.keys(rec);
	if (keys.length === 0) return '';
	return JSON.stringify(rec, null, 2);
}

/** Derives a short file name from a tool input's filePath field. */
export function fileTitlePresenter(input: ToolPayload): string {
	const fp = input.filePath as string | undefined;
	return fp?.split('/').pop() || fp || 'file';
}

/** Builds diff content props from old/new string fields. */
export function diffProps(
	input: ToolPayload,
	badge: string,
	badgeColor: string,
): Record<string, unknown> {
	return {
		oldContent: input.oldString,
		newContent: input.newString,
		filePath: input.filePath,
		showHeader: false,
		badge,
		badgeColor,
	};
}
