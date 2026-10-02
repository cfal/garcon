import { promises as fs } from 'fs';
import { GitDomainError } from './git-domain-error.js';
import { assertGitWorkingPath } from './operation-context.js';
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

async function readWorkingConflictContent(projectPath: string, file: string): Promise<GitConflictContent> {
  try {
    const workingPath = resolvePathWithinProject(projectPath, file);
    await assertGitWorkingPath(workingPath);
    const stats = await fs.stat(workingPath);
    if (stats.size > MAX_CONFLICT_CONTENT_BYTES) {
      return {
        content: null,
        truncated: true,
        byteLength: stats.size,
        lineCount: 0,
        limitReason: 'content-too-large',
      };
    }
    const content = await fs.readFile(workingPath, 'utf-8');
    return limitConflictContent(content, Buffer.byteLength(content));
  } catch {
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
    readWorkingConflictContent(projectPath, file),
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
  await runGit(projectPath, ['checkout', side === 'ours' ? '--ours' : '--theirs', '--', file], { signal });
  await runGit(projectPath, ['add', '--', file], { signal });
  return { success: true };
}

async function markConflictResolved({
  projectPath,
  file,
  signal,
}: FileOptions): Promise<{ success: boolean }> {
  await assertGitRepository(projectPath);
  const workingPath = resolvePathWithinProject(projectPath, file);
  await assertGitWorkingPath(workingPath);
  const working = await fs.readFile(workingPath, 'utf-8');
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(working)) {
    throw new GitDomainError(
      'INVALID_INPUT',
      'Conflict markers remain in this file. Remove them before marking it resolved.',
    );
  }
  await runGit(projectPath, ['add', '--', file], { signal });
  return { success: true };
}

export function createConflictOperations() {
  return { getConflicts, getConflictDetails, acceptConflictSide, markConflictResolved };
}
