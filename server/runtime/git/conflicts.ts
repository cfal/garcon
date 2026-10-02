import { constants, promises as fs } from 'fs';
import { StringDecoder } from 'node:string_decoder';
import { GitDomainError } from './git-domain-error.js';
import { assertGitWorkingPath, gitOperationSignal } from './operation-context.js';
import { literalGitPathspec } from './pathspecs.js';
import { parsePorcelainV1Z, UNMERGED_STATUSES } from './porcelain-status.js';
import {
  assertGitRepository,
  readOnlyGitOptions,
  resolvePathWithinProject,
  runGit,
} from './run.js';
import type {
  ConflictAcceptOptions,
  ConflictDetailsOptions,
  FileOptions,
  GitConflictContent,
  GitConflictDetails,
  GitConflictFile,
  GitConflictStatus,
  ProjectOptions
} from './types.js';

const MAX_CONFLICT_CONTENT_BYTES = 256 * 1024;
const MAX_CONFLICT_CONTENT_LINES = 4_000;

function emptyConflictContent(): GitConflictContent {
  return {
    content: null,
    truncated: false,
    byteLength: 0,
    lineCount: 0,
  };
}

function limitConflictContent(content: string, byteLength: number): GitConflictContent {
  const lines = content.split('\n');
  if (lines.length > MAX_CONFLICT_CONTENT_LINES) {
    return {
      content: lines.slice(0, MAX_CONFLICT_CONTENT_LINES).join('\n'),
      truncated: true,
      byteLength,
      lineCount: lines.length,
      limitReason: 'too-many-lines',
    };
  }

  return {
    content,
    truncated: false,
    byteLength,
    lineCount: lines.length,
  };
}

function parseUnmergedIndexStages(output: string): Map<string, Set<1 | 2 | 3>> {
  const stagesByPath = new Map<string, Set<1 | 2 | 3>>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    if (separator < 0) continue;
    const metadata = record.slice(0, separator).trim().split(/\s+/);
    const stage = Number(metadata[2]);
    if (stage !== 1 && stage !== 2 && stage !== 3) continue;
    const filePath = record.slice(separator + 1);
    const stages = stagesByPath.get(filePath) ?? new Set<1 | 2 | 3>();
    stages.add(stage);
    stagesByPath.set(filePath, stages);
  }
  return stagesByPath;
}

async function readStageBlob(
  projectPath: string,
  stage: 1 | 2 | 3,
  file: string,
  signal?: AbortSignal,
): Promise<GitConflictContent> {
  try {
    const sizeResult = await runGit(
      projectPath,
      ['cat-file', '-s', `:${stage}:${file}`],
      readOnlyGitOptions({ signal }),
    );
    const byteLength = Number(sizeResult.stdout.trim());
    if (Number.isFinite(byteLength) && byteLength > MAX_CONFLICT_CONTENT_BYTES) {
      return {
        content: null,
        truncated: true,
        byteLength,
        lineCount: 0,
        limitReason: 'content-too-large',
      };
    }
    const { stdout } = await runGit(
      projectPath,
      ['show', `:${stage}:${file}`],
      readOnlyGitOptions({ signal }),
    );
    return limitConflictContent(stdout, Buffer.byteLength(stdout));
  } catch {
    return emptyConflictContent();
  }
}

async function openWorkingConflictFile(projectPath: string, file: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const workingPath = resolvePathWithinProject(projectPath, file);
  await assertGitWorkingPath(workingPath);
  const realPath = await fs.realpath(workingPath);
  await assertGitWorkingPath(realPath);
  const handle = await fs.open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new GitDomainError('INVALID_INPUT', 'Conflict content must be a regular file.');
    await assertGitWorkingPath(workingPath);
    const current = await fs.stat(workingPath);
    if (stats.dev !== current.dev || stats.ino !== current.ino) {
      throw new GitDomainError('INVALID_INPUT', 'Conflict file changed while opening it.');
    }
    signal?.throwIfAborted();
    return { handle, stats };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readWorkingConflictContent(projectPath: string, file: string, signal?: AbortSignal): Promise<GitConflictContent> {
  try {
    const { handle, stats } = await openWorkingConflictFile(projectPath, file, signal);
    try {
      let byteLength = stats.size;
      if (byteLength <= MAX_CONFLICT_CONTENT_BYTES) {
        const buffer = Buffer.allocUnsafe(MAX_CONFLICT_CONTENT_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, size, Math.min(64 * 1024, buffer.length - size));
          signal?.throwIfAborted();
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size <= MAX_CONFLICT_CONTENT_BYTES) {
          return limitConflictContent(buffer.subarray(0, size).toString('utf8'), size);
        }
        byteLength = Math.max(size, (await handle.stat()).size);
      }
      return {
        content: null,
        truncated: true,
        byteLength,
        lineCount: 0,
        limitReason: 'content-too-large',
      };
    } finally {
      await handle.close();
    }
  } catch {
    signal?.throwIfAborted();
    return emptyConflictContent();
  }
}

async function getConflicts({
  projectPath,
  signal,
}: ProjectOptions): Promise<{ conflicts: GitConflictFile[] }> {
  await assertGitRepository(projectPath);
  const [statusResult, unmergedResult] = await Promise.all([
    runGit(
      projectPath,
      ['status', '--porcelain=v1', '-z', '-uall'],
      readOnlyGitOptions({ signal }),
    ),
    runGit(
      projectPath,
      ['ls-files', '-u', '-z'],
      readOnlyGitOptions({ signal }),
    ),
  ]);
  const stagesByPath = parseUnmergedIndexStages(unmergedResult.stdout);
  const conflicts: GitConflictFile[] = [];
  for (const entry of parsePorcelainV1Z(statusResult.stdout)) {
    const status = `${entry.indexStatus}${entry.workTreeStatus}`;
    if (!UNMERGED_STATUSES.has(status)) continue;
    const stages = stagesByPath.get(entry.path) ?? new Set<1 | 2 | 3>();
    conflicts.push({
      path: entry.path,
      status: status as GitConflictStatus,
      baseAvailable: stages.has(1),
      oursAvailable: stages.has(2),
      theirsAvailable: stages.has(3),
    });
  }
  return { conflicts };
}

async function getConflictDetails({
  projectPath,
  file,
  signal,
}: ConflictDetailsOptions): Promise<GitConflictDetails> {
  await assertGitRepository(projectPath);
  const [base, ours, theirs, working] = await Promise.all([
    readStageBlob(projectPath, 1, file, signal),
    readStageBlob(projectPath, 2, file, signal),
    readStageBlob(projectPath, 3, file, signal),
    readWorkingConflictContent(projectPath, file, gitOperationSignal() ?? signal),
  ]);
  return {
    path: file,
    base,
    ours,
    theirs,
    working,
    truncated: base.truncated || ours.truncated || theirs.truncated || working.truncated,
  };
}

async function acceptConflictSide({
  projectPath,
  file,
  side,
  signal,
}: ConflictAcceptOptions): Promise<{ success: boolean }> {
  await assertGitRepository(projectPath);
  await runGit(projectPath, ['checkout', side === 'ours' ? '--ours' : '--theirs', '--', literalGitPathspec(file)], { signal });
  await runGit(projectPath, ['add', '--', literalGitPathspec(file)], { signal });
  return { success: true };
}

async function markConflictResolved({
  projectPath,
  file,
  signal,
}: FileOptions): Promise<{ success: boolean }> {
  await assertGitRepository(projectPath);
  const readSignal = gitOperationSignal() ?? signal;
  const { handle } = await openWorkingConflictFile(projectPath, file, readSignal);
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const decoder = new StringDecoder('utf8');
    // Retains only enough text to recognize a line boundary plus a split marker.
    let tail = '\n';
    while (true) {
      readSignal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer);
      readSignal?.throwIfAborted();
      const text = tail + (bytesRead === 0 ? decoder.end() : decoder.write(buffer.subarray(0, bytesRead)));
      if (/[\r\n\u2028\u2029](<<<<<<<|=======|>>>>>>>)/.test(text)) {
        throw new GitDomainError(
          'INVALID_INPUT',
          'Conflict markers remain in this file. Remove them before marking it resolved.',
        );
      }
      if (bytesRead === 0) break;
      tail = text.slice(-7);
    }
  } finally {
    await handle.close();
  }
  readSignal?.throwIfAborted();
  await runGit(projectPath, ['add', '--', literalGitPathspec(file)], { signal });
  return { success: true };
}

export function createConflictOperations() {
  return { getConflicts, getConflictDetails, acceptConflictSide, markConflictResolved };
}
