import { promises as fs } from 'fs';
import path from 'path';

export interface FileMentionToken {
	path: string;
	start: number;
	end: number;
}

const MAX_MENTIONED_FILES = 8;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 384 * 1024;
const BINARY_SAMPLE_BYTES = 4096;
const FILE_CONTEXT_SEPARATOR = '\n\nReferenced file contents from @file mentions:\n\n';

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

function isWithinRoot(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root}${path.sep}`);
}

function resolveWithinProject(projectPath: string, inputPath: string): string | null {
	const root = path.resolve(projectPath);
	const resolved = path.isAbsolute(inputPath)
		? path.resolve(inputPath)
		: path.resolve(root, inputPath);
	if (isWithinRoot(root, resolved)) return resolved;
	return null;
}

function pathCandidates(inputPath: string): string[] {
	const candidates = [inputPath];
	const stripped = inputPath.replace(/[),.;:!?]+$/, '');
	if (stripped && stripped !== inputPath) candidates.push(stripped);
	return candidates;
}

async function resolveExistingFile(projectPath: string, realProjectPath: string, inputPath: string): Promise<string | null> {
	for (const candidate of pathCandidates(inputPath)) {
		const resolved = resolveWithinProject(projectPath, candidate);
		if (!resolved) continue;
		const realPath = await fs.realpath(resolved).catch(() => null);
		if (!realPath || !isWithinRoot(realProjectPath, realPath)) continue;
		const stat = await fs.stat(realPath).catch(() => null);
		if (stat?.isFile()) return realPath;
	}
	return null;
}

function isProbablyBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, Math.min(buffer.length, BINARY_SAMPLE_BYTES)).includes(0);
}

function displayPath(projectPath: string, filePath: string): string {
	return path.relative(path.resolve(projectPath), filePath).split(path.sep).join('/');
}

function fenceFor(content: string): string {
	let longest = 0;
	for (const match of content.matchAll(/`{3,}/g)) {
		longest = Math.max(longest, match[0].length);
	}
	return '`'.repeat(Math.max(3, longest + 1));
}

function formatFileSection(relativePath: string, content: string, truncated: boolean): string {
	const fence = fenceFor(content);
	const suffix = truncated
		? `\n\n[Garcon truncated this file at ${MAX_FILE_BYTES} bytes.]`
		: '';
	return `@${relativePath}\n${fence}\n${content}${suffix}\n${fence}`;
}

export async function resolveFileMentionsInCommand(command: string, projectPath: string): Promise<string> {
	if (!command.includes('@') || !projectPath) return command;

	const tokens = parseFileMentionTokens(command);
	if (tokens.length === 0) return command;

	const realProjectPath = await fs.realpath(projectPath).catch(() => null);
	if (!realProjectPath) return command;
	const resolvedFiles: string[] = [];
	const seen = new Set<string>();
	for (const token of tokens) {
		if (resolvedFiles.length >= MAX_MENTIONED_FILES) break;
		const filePath = await resolveExistingFile(projectPath, realProjectPath, token.path);
		if (!filePath || seen.has(filePath)) continue;
		seen.add(filePath);
		resolvedFiles.push(filePath);
	}
	if (resolvedFiles.length === 0) return command;

	const sections: string[] = [];
	let totalBytes = 0;
	for (const filePath of resolvedFiles) {
		const relativePath = displayPath(realProjectPath, filePath);
		const buffer = await fs.readFile(filePath).catch(() => null);
		if (!buffer) continue;
		if (isProbablyBinary(buffer)) {
			sections.push(`@${relativePath}\n[Garcon omitted this binary file.]`);
			continue;
		}
		if (totalBytes >= MAX_TOTAL_BYTES) {
			sections.push(`@${relativePath}\n[Garcon omitted this file because the @file context limit was reached.]`);
			continue;
		}
		const remainingBytes = MAX_TOTAL_BYTES - totalBytes;
		const allowedBytes = Math.min(buffer.length, MAX_FILE_BYTES, remainingBytes);
		const truncated = buffer.length > allowedBytes;
		const content = buffer.subarray(0, allowedBytes).toString('utf8');
		totalBytes += allowedBytes;
		sections.push(formatFileSection(relativePath, content, truncated));
	}

	if (sections.length === 0) return command;
	return `${command}${FILE_CONTEXT_SEPARATOR}${sections.join('\n\n')}`;
}

export function stripResolvedFileMentionContext(content: string): string {
	const index = content.indexOf(FILE_CONTEXT_SEPARATOR);
	return index === -1 ? content : content.slice(0, index);
}
