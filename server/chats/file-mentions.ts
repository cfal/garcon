import { constants, promises as fs, type Stats } from 'fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'path';
import { FILE_CONTEXT_SEPARATOR, stripResolvedFileMentionContext } from '../agents/shared/file-mention-context.js';

export interface FileMentionToken {
	path: string;
	start: number;
	end: number;
}

const MAX_MENTIONED_FILES = 8;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 384 * 1024;
const BINARY_SAMPLE_BYTES = 4096;

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

interface OpenedMentionFile {
	canonicalPath: string;
	handle: FileHandle;
}

function isSameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function openExistingFile(
	projectPath: string,
	realProjectPath: string,
	inputPath: string,
): Promise<OpenedMentionFile | null> {
	for (const candidate of pathCandidates(inputPath)) {
		const resolved = resolveWithinProject(projectPath, candidate);
		if (!resolved) continue;
		const realPath = await fs.realpath(resolved).catch(() => null);
		if (!realPath || !isWithinRoot(realProjectPath, realPath)) continue;
		const handle = await fs.open(
			realPath,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		).catch(() => null);
		if (!handle) continue;
		let accepted = false;
		try {
			const openedStat = await handle.stat();
			if (!openedStat.isFile()) continue;
			const verifiedPath = await fs.realpath(realPath);
			if (!isWithinRoot(realProjectPath, verifiedPath)) continue;
			const verifiedStat = await fs.stat(verifiedPath);
			if (!isSameFile(openedStat, verifiedStat)) continue;
			accepted = true;
			return { canonicalPath: verifiedPath, handle };
		} catch {
			continue;
		} finally {
			if (!accepted) await handle.close().catch(() => undefined);
		}
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

async function readFilePrefix(handle: FileHandle, contentLimit: number): Promise<{
	buffer: Buffer;
	contentLength: number;
	truncated: boolean;
} | null> {
	const readLimit = Math.max(BINARY_SAMPLE_BYTES, contentLimit + 1);
	try {
		const buffer = Buffer.allocUnsafe(readLimit);
		let bytesRead = 0;
		while (bytesRead < readLimit) {
			const result = await handle.read(
				buffer,
				bytesRead,
				readLimit - bytesRead,
				bytesRead,
			);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		return {
			buffer: buffer.subarray(0, bytesRead),
			contentLength: Math.min(bytesRead, contentLimit),
			truncated: bytesRead > contentLimit,
		};
	} catch {
		return null;
	}
}

export async function resolveFileMentionsInCommand(command: string, projectPath: string): Promise<string> {
	if (!command.includes('@') || !projectPath) return command;

	const tokens = parseFileMentionTokens(command);
	if (tokens.length === 0) return command;

	const realProjectPath = await fs.realpath(projectPath).catch(() => null);
	if (!realProjectPath) return command;
	const resolvedFiles: OpenedMentionFile[] = [];
	const seen = new Set<string>();
	for (const token of tokens) {
		if (resolvedFiles.length >= MAX_MENTIONED_FILES) break;
		const opened = await openExistingFile(projectPath, realProjectPath, token.path);
		if (!opened) continue;
		if (seen.has(opened.canonicalPath)) {
			await opened.handle.close().catch(() => undefined);
			continue;
		}
		seen.add(opened.canonicalPath);
		resolvedFiles.push(opened);
	}
	if (resolvedFiles.length === 0) return command;

	const sections: string[] = [];
	let totalBytes = 0;
	try {
		for (const { canonicalPath, handle } of resolvedFiles) {
			const relativePath = displayPath(realProjectPath, canonicalPath);
			if (totalBytes >= MAX_TOTAL_BYTES) {
				sections.push(`@${relativePath}\n[Garcon omitted this file because the @file context limit was reached.]`);
				continue;
			}
			const remainingBytes = MAX_TOTAL_BYTES - totalBytes;
			const allowedBytes = Math.min(MAX_FILE_BYTES, remainingBytes);
			const prefix = await readFilePrefix(handle, allowedBytes);
			if (!prefix) continue;
			if (isProbablyBinary(prefix.buffer)) {
				sections.push(`@${relativePath}\n[Garcon omitted this binary file.]`);
				continue;
			}
			const content = prefix.buffer.subarray(0, prefix.contentLength).toString('utf8');
			totalBytes += prefix.contentLength;
			sections.push(formatFileSection(relativePath, content, prefix.truncated));
		}
	} finally {
		await Promise.all(resolvedFiles.map(({ handle }) => handle.close().catch(() => undefined)));
	}

	if (sections.length === 0) return command;
	return `${command}${FILE_CONTEXT_SEPARATOR}${sections.join('\n\n')}`;
}

export { stripResolvedFileMentionContext };
