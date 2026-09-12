import type { LocatedChatOwner } from '../../common/execution-location.js';

export interface FileMentionTarget extends LocatedChatOwner {
  readonly projectPath: string;
}

export interface FileMentionResolver {
  resolve(command: string, target: FileMentionTarget, signal: AbortSignal): Promise<string>;
}

export interface FileMentionToken {
	path: string;
	start: number;
	end: number;
}

function canStartMention(input: string, index: number): boolean {
	return index === 0 || /\s/.test(input[index - 1]);
}

function parseQuotedMention(input: string, start: number, quote: string): { value: string; end: number } | null {
	let value = '';
	for (let index = start; index < input.length; index += 1) {
		const ch = input[index];
		if (ch === '\\' && index + 1 < input.length) {
			value += input[index + 1];
			index += 1;
			continue;
		}
		if (ch === quote) return { value, end: index + 1 };
		value += ch;
	}
	return null;
}

function parseBareMention(input: string, start: number): { value: string; end: number } | null {
	let end = start;
	while (end < input.length && !/\s/.test(input[end])) end += 1;
	const value = input.slice(start, end);
	return value ? { value, end } : null;
}

export function parseFileMentionTokens(input: string): FileMentionToken[] {
	const mentions: FileMentionToken[] = [];
	for (let index = 0; index < input.length; index += 1) {
		if (input[index] !== '@' || !canStartMention(input, index)) continue;
		const next = input[index + 1];
		const parsed = next === '"' || next === "'"
			? parseQuotedMention(input, index + 2, next)
			: parseBareMention(input, index + 1);
		if (!parsed?.value) continue;
		mentions.push({ path: parsed.value, start: index, end: parsed.end });
		index = parsed.end - 1;
	}
	return mentions;
}

export { stripResolvedFileMentionContext } from '../agents/shared/file-mention-context.js';
