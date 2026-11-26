// Pure helper functions for tool display formatting. Extracted from
// the monolithic tool-renderers module for testability and reuse.

import * as m from '$lib/paraglide/messages.js';
import type { ToolPayload } from '$lib/chat/tools/tool-display-contract.js';
import { isEmptyToolResult } from '$shared/tool-result-content';
import { isRecord } from '$shared/json';

interface ReadRangePayload {
	offset?: unknown;
	startLine?: unknown;
	limit?: unknown;
	numLines?: unknown;
	endLine?: unknown;
}

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
export function readRangePresenter(input: ReadRangePayload): string | undefined {
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

function formatToolReport(content: unknown, formatBody: (body: ToolPayload) => string): string {
	if (!isRecord(content)) return '';
	if (content.toolUseResult == null) return formatBody(content);
	const { toolUseResult, ...body } = content;
	const text = isEmptyToolResult(body) ? '' : formatBody(body);
	const details = JSON.stringify(toolUseResult, null, 2);
	return text && text !== details ? `${text}\n\n${details}` : details;
}

function reportedResultBody(content: ToolPayload): string {
	const { raw, rawOutput, items } = content;
	const text = typeof raw === 'string' ? raw : '';
	if (rawOutput === undefined) {
		if (text) return text;
		if (Array.isArray(items) && items.every(item => item?.type === 'text' && typeof item.text === 'string' && Object.keys(item).length === 2)) {
			const body = items.map(item => item.text).join('\n');
			if (body) return body;
		}
		return extractContentString(content);
	}
	if (rawOutput && typeof rawOutput === 'object' && 'output' in rawOutput && typeof rawOutput.output === 'string') {
		const { output, ...metadata } = rawOutput;
		const hasMetadata = Object.keys(metadata).length > 0;
		if (!text || text === output) {
			const details = hasMetadata ? JSON.stringify(metadata, null, 2) : '';
			if (!/\S/.test(output)) return details;
			return details ? output + '\n\n' + details : output;
		}
		if (!hasMetadata) return text;
	}
	// A second plain output string is supplementary progress, not another result.
	if (text && typeof rawOutput === 'string') return text;
	const details = JSON.stringify(rawOutput, null, 2);
	return text ? text + '\n\n' + details : details;
}

export function reportedResultProps(result: ToolPayload) {
	return { content: reportedToolResultText(result.content), format: 'plain' };
}

export function reportedToolResultText(content: unknown): string {
	return formatToolReport(content, reportedResultBody);
}

function completeReportBody(body: ToolPayload): string {
	const fields = Object.keys(body).filter(key => key !== 'status');
	// Plain-text shortcuts are safe only if they account for every field in the report.
	if (fields.length === 0 || (fields.length === 1 && ['raw', 'rawOutput', 'items'].includes(fields[0]))) return reportedResultBody(body);
	return JSON.stringify(body, null, 2);
}

export function completeReportProps(result: ToolPayload) {
	return { content: formatToolReport(result.content, completeReportBody), format: 'plain' };
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

export function truncate(value: string, limit: number): string {
	return value.length > limit ? value.slice(0, limit) + '...' : value;
}
