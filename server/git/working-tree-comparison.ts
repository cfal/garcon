import { promises as fs } from 'fs';
import { buildFullFileAddedPatch } from './full-file-patch.js';
import { limitedFileBody, limitedRenderedPatch } from './rendered-diff.js';
import { resolvePathWithinProject } from './run.js';
import {
  GIT_REVIEW_DOCUMENT_LIMITS,
  type GitComparisonFileRequest,
  type GitReviewFileBody,
} from './types.js';

export interface UntrackedSummaryBudget {
  remainingBytes: number;
}

export interface UntrackedFileSummary {
  isBinary: boolean;
  isTooLarge: boolean;
  unsupported: boolean;
  additions: number;
  statsKnown: boolean;
}

export function createUntrackedSummaryBudget(): UntrackedSummaryBudget {
  return { remainingBytes: GIT_REVIEW_DOCUMENT_LIMITS.maxLoadedPatchBytes };
}

export async function summarizeUntrackedFile(
  projectPath: string,
  filePath: string,
  budget: UntrackedSummaryBudget,
  signal?: AbortSignal,
): Promise<UntrackedFileSummary> {
  try {
    return await inspectUntrackedFile(projectPath, filePath, budget, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      isBinary: false,
      isTooLarge: false,
      unsupported: true,
      additions: 0,
      statsKnown: true,
    };
  }
}

async function inspectUntrackedFile(
  projectPath: string,
  filePath: string,
  budget: UntrackedSummaryBudget,
  signal?: AbortSignal,
): Promise<UntrackedFileSummary> {
  signal?.throwIfAborted();
  const resolvedPath = resolvePathWithinProject(projectPath, filePath);
  const pathStats = await fs.lstat(resolvedPath);
  signal?.throwIfAborted();
  if (!pathStats.isFile()) {
    return {
      isBinary: false,
      isTooLarge: false,
      unsupported: true,
      additions: 0,
      statsKnown: true,
    };
  }

  const handle = await fs.open(resolvedPath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return {
        isBinary: false,
        isTooLarge: false,
        unsupported: true,
        additions: 0,
        statsKnown: true,
      };
    }
    const byteLimit = GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes;
    if (stats.size > byteLimit) {
      return {
        isBinary: false,
        isTooLarge: true,
        unsupported: false,
        additions: 0,
        statsKnown: true,
      };
    }

    const countAdditions = stats.size <= budget.remainingBytes;
    if (countAdditions) budget.remainingBytes -= stats.size;
    const readLimit = countAdditions ? stats.size : Math.min(stats.size, 8192);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, readLimit)));
    let bytesRead = 0;
    let newlineCount = 0;
    let lastByte = -1;
    while (bytesRead < readLimit) {
      signal?.throwIfAborted();
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, readLimit - bytesRead),
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      if (chunk.includes(0x00)) {
        return {
          isBinary: true,
          isTooLarge: false,
          unsupported: false,
          additions: 0,
          statsKnown: true,
        };
      }
      if (countAdditions) {
        for (const byte of chunk) {
          if (byte === 0x0a) newlineCount += 1;
        }
        lastByte = chunk.at(-1) ?? lastByte;
      }
      bytesRead += result.bytesRead;
    }
    return {
      isBinary: false,
      isTooLarge: false,
      unsupported: false,
      additions: countAdditions && bytesRead > 0 ? newlineCount + (lastByte === 0x0a ? 0 : 1) : 0,
      statsKnown: countAdditions,
    };
  } finally {
    await handle.close();
  }
}

type UntrackedFileRead =
  | { status: 'text'; content: string }
  | { status: 'binary' }
  | { status: 'too-large' }
  | { status: 'unsupported' };

async function readUntrackedFile(
  projectPath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<UntrackedFileRead> {
  signal?.throwIfAborted();
  const resolvedPath = resolvePathWithinProject(projectPath, filePath);
  const pathStats = await fs.lstat(resolvedPath);
  signal?.throwIfAborted();
  if (!pathStats.isFile()) return { status: 'unsupported' };

  const handle = await fs.open(resolvedPath, 'r');
  try {
    signal?.throwIfAborted();
    const stats = await handle.stat();
    if (!stats.isFile()) return { status: 'unsupported' };
    const byteLimit = GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes;
    if (stats.size > byteLimit) return { status: 'too-large' };

    const chunks: Buffer[] = [];
    const readBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, byteLimit + 1));
    let bytesRead = 0;
    while (bytesRead <= byteLimit) {
      signal?.throwIfAborted();
      const result = await handle.read(readBuffer, 0, readBuffer.length, bytesRead);
      if (result.bytesRead === 0) break;
      const chunk = Buffer.from(readBuffer.subarray(0, result.bytesRead));
      if (chunk.includes(0x00)) return { status: 'binary' };
      chunks.push(chunk);
      bytesRead += result.bytesRead;
      if (bytesRead > byteLimit) return { status: 'too-large' };
    }
    signal?.throwIfAborted();
    return { status: 'text', content: Buffer.concat(chunks, bytesRead).toString('utf8') };
  } finally {
    await handle.close();
  }
}

export async function loadUntrackedComparisonBody(
  projectPath: string,
  file: GitComparisonFileRequest,
  fingerprint: string,
  signal?: AbortSignal,
): Promise<GitReviewFileBody> {
  const result = await readUntrackedFile(projectPath, file.path, signal);
  if (result.status === 'unsupported') {
    return limitedFileBody(
      file.path,
      fingerprint,
      'unsupported-file-kind',
      'Only regular untracked files can be displayed.',
    );
  }
  if (result.status === 'binary') {
    return limitedFileBody(file.path, fingerprint, 'binary', 'Binary diff is not available.');
  }
  if (result.status === 'too-large') {
    return limitedFileBody(
      file.path,
      fingerprint,
      'file-too-many-bytes',
      `File exceeds ${GIT_REVIEW_DOCUMENT_LIMITS.maxFilePatchBytes} byte display limit.`,
    );
  }
  return limitedRenderedPatch(file.path, fingerprint, buildFullFileAddedPatch(result.content));
}
