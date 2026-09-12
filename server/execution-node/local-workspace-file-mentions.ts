import { constants, promises as fs, type Stats } from 'fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'path';
import { FILE_CONTEXT_SEPARATOR } from '../agents/shared/file-mention-context.js';
import { parseFileMentionTokens } from '../chats/file-mentions.js';
import type { WorkspaceFileMentionRequest, WorkspaceFileMentionService } from '../execution-nodes/workspace-file-mentions.js';

const MAX_MENTIONED_FILES = 8;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 384 * 1024;
const BINARY_SAMPLE_BYTES = 4096;

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
	signal: AbortSignal,
): Promise<OpenedMentionFile | null> {
	for (const candidate of pathCandidates(inputPath)) {
		signal.throwIfAborted();
		const resolved = resolveWithinProject(projectPath, candidate);
		if (!resolved) continue;
		const realPath = await fs.realpath(resolved).catch(() => null);
		signal.throwIfAborted();
		if (!realPath || !isWithinRoot(realProjectPath, realPath)) continue;
		const handle = await fs.open(
			realPath,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		).catch(() => null);
		if (!handle) continue;
		let accepted = false;
		try {
			signal.throwIfAborted();
			const openedStat = await handle.stat();
			if (!openedStat.isFile()) continue;
			const verifiedPath = await fs.realpath(realPath);
			if (!isWithinRoot(realProjectPath, verifiedPath)) continue;
			const verifiedStat = await fs.stat(verifiedPath);
			signal.throwIfAborted();
			if (!isSameFile(openedStat, verifiedStat)) continue;
			accepted = true;
			return { canonicalPath: verifiedPath, handle };
		} catch {
			signal.throwIfAborted();
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

async function readFilePrefix(handle: FileHandle, contentLimit: number, signal: AbortSignal): Promise<{
	buffer: Buffer;
	contentLength: number;
	truncated: boolean;
} | null> {
	const readLimit = Math.max(BINARY_SAMPLE_BYTES, contentLimit + 1);
	try {
		const buffer = Buffer.allocUnsafe(readLimit);
		let bytesRead = 0;
		while (bytesRead < readLimit) {
			signal.throwIfAborted();
			const result = await handle.read(
				buffer,
				bytesRead,
				readLimit - bytesRead,
				bytesRead,
			);
			signal.throwIfAborted();
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		return {
			buffer: buffer.subarray(0, bytesRead),
			contentLength: Math.min(bytesRead, contentLimit),
			truncated: bytesRead > contentLimit,
		};
	} catch {
		signal.throwIfAborted();
		return null;
	}
}

export class LocalWorkspaceFileMentionService implements WorkspaceFileMentionService {
  resolve(request: WorkspaceFileMentionRequest, signal: AbortSignal): Promise<string> {
    return resolveFileMentionsInCommand(request.command, request.projectPath, signal);
  }
}

async function resolveFileMentionsInCommand(command: string, projectPath: string, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	if (!command.includes('@') || !projectPath) return command;

	const tokens = parseFileMentionTokens(command);
	if (tokens.length === 0) return command;

	const realProjectPath = await fs.realpath(projectPath).catch(() => null);
	signal.throwIfAborted();
	if (!realProjectPath) return command;
	const resolvedFiles: OpenedMentionFile[] = [];
	const seen = new Set<string>();
	const sections: string[] = [];
	let totalBytes = 0;
	try {
		for (const token of tokens) {
			if (resolvedFiles.length >= MAX_MENTIONED_FILES) break;
			const opened = await openExistingFile(projectPath, realProjectPath, token.path, signal);
			if (!opened) continue;
			if (seen.has(opened.canonicalPath)) {
				await opened.handle.close().catch(() => undefined);
				continue;
			}
			seen.add(opened.canonicalPath);
			resolvedFiles.push(opened);
		}
		for (const { canonicalPath, handle } of resolvedFiles) {
			signal.throwIfAborted();
			const relativePath = displayPath(realProjectPath, canonicalPath);
			if (totalBytes >= MAX_TOTAL_BYTES) {
				sections.push(`@${relativePath}\n[Garcon omitted this file because the @file context limit was reached.]`);
				continue;
			}
			const remainingBytes = MAX_TOTAL_BYTES - totalBytes;
			const allowedBytes = Math.min(MAX_FILE_BYTES, remainingBytes);
			const prefix = await readFilePrefix(handle, allowedBytes, signal);
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

	signal.throwIfAborted();
	if (sections.length === 0) return command;
	return `${command}${FILE_CONTEXT_SEPARATOR}${sections.join('\n\n')}`;
}
