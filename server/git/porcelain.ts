import { promises as fs } from 'fs';
import {
  assertGitRepository,
  readOnlyGitOptions,
  resolvePathWithinProject,
  runGit,
} from './run.js';
import { parseNumstatZ } from './diff-file-list.js';
import { assertExistingCommitRef } from './ref-validation.js';
import type {
  BlameOptions,
  ConflictAcceptOptions,
  ConflictDetailsOptions,
  FileHistoryOptions,
  FileOptions,
  GitBlameLine,
  GitConflictContent,
  GitConflictDetails,
  GitConflictFile,
  GitConflictStatus,
  GitFileHistoryEntry,
  GitGraphCommit,
  GitStashEntry,
  GraphOptions,
  ProjectOptions,
  StashCreateOptions,
  StashRefOptions,
} from './types.js';
import { GitDomainError } from './git-types.js';

const UNMERGED_STATUSES = new Set<GitConflictStatus>(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
const MAX_HISTORY_LIMIT = 200;
const MAX_BLAME_LINES = 2_000;
const MAX_GRAPH_LIMIT = 500;
const MAX_CONFLICT_CONTENT_BYTES = 256 * 1024;
const MAX_CONFLICT_CONTENT_LINES = 4_000;

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) return fallback;
  return Math.min(value, max);
}

function assertSafeStashRef(stashRef: string): void {
  if (!/^stash@\{\d+\}$/.test(stashRef)) {
    throw new GitDomainError('INVALID_INPUT', 'Invalid stash ref.');
  }
}

function parsePorcelainStatus(output: string): Array<{ path: string; status: string }> {
  const tokens = output.split('\0').filter(Boolean);
  const entries: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = `${token[0] || ' '}${token[1] || ' '}`;
    const filePath = token.slice(3);
    entries.push({ path: filePath, status });
    if (status[0] === 'R' || status[0] === 'C') index += 1;
  }
  return entries;
}

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
  for (const entry of parsePorcelainStatus(statusResult.stdout)) {
    if (!UNMERGED_STATUSES.has(entry.status as GitConflictStatus)) continue;
    const stages = stagesByPath.get(entry.path) ?? new Set<1 | 2 | 3>();
    conflicts.push({
      path: entry.path,
      status: entry.status as GitConflictStatus,
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

function parseStashes(output: string): GitStashEntry[] {
  return output
    .split('\x1e')
    .filter(Boolean)
    .map((entry) => {
      const [ref = '', hash = '', date = '', message = ''] = entry.split('\0');
      const indexMatch = ref.match(/^stash@\{(\d+)\}$/);
      return {
        index: indexMatch ? Number(indexMatch[1]) : -1,
        ref,
        hash,
        date,
        message,
      };
    });
}

async function getStashes({ projectPath, signal }: ProjectOptions): Promise<{ stashes: GitStashEntry[] }> {
  await assertGitRepository(projectPath);
  const { stdout } = await runGit(
    projectPath,
    ['stash', 'list', '--date=iso', '--format=%gd%x00%H%x00%ci%x00%s%x1e'],
    readOnlyGitOptions({ signal }),
  );
  return { stashes: parseStashes(stdout) };
}

async function createStash({
  projectPath,
  message,
  includeUntracked,
  signal,
}: StashCreateOptions): Promise<{ success: boolean; output: string }> {
  await assertGitRepository(projectPath);
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('-u');
  if (message?.trim()) args.push('-m', message.trim());
  const { stdout } = await runGit(projectPath, args, { signal });
  return { success: true, output: stdout.trim() };
}

async function applyStash({ projectPath, stashRef, signal }: StashRefOptions): Promise<{ success: boolean }> {
  assertSafeStashRef(stashRef);
  await assertGitRepository(projectPath);
  await runGit(projectPath, ['stash', 'apply', stashRef], { signal });
  return { success: true };
}

async function popStash({ projectPath, stashRef, signal }: StashRefOptions): Promise<{ success: boolean }> {
  assertSafeStashRef(stashRef);
  await assertGitRepository(projectPath);
  await runGit(projectPath, ['stash', 'pop', stashRef], { signal });
  return { success: true };
}

async function dropStash({ projectPath, stashRef, signal }: StashRefOptions): Promise<{ success: boolean }> {
  assertSafeStashRef(stashRef);
  await assertGitRepository(projectPath);
  await runGit(projectPath, ['stash', 'drop', stashRef], { signal });
  return { success: true };
}

function parseFileHistory(output: string): GitFileHistoryEntry[] {
  return output
    .split('\x1e')
    .filter(Boolean)
    .map((entry) => {
      const [hash = '', author = '', email = '', date = '', subject = ''] = entry.split('\0');
      return { hash, author, email, date, subject };
    });
}

async function getFileHistory({
  projectPath,
  file,
  limit,
  signal,
}: FileHistoryOptions): Promise<{ commits: GitFileHistoryEntry[] }> {
  await assertGitRepository(projectPath);
  const safeLimit = clampLimit(limit, 50, MAX_HISTORY_LIMIT);
  const { stdout } = await runGit(
    projectPath,
    ['log', '--follow', `-n${safeLimit}`, '--format=%H%x00%an%x00%ae%x00%ai%x00%s%x1e', '--', file],
    readOnlyGitOptions({ signal }),
  );
  return { commits: parseFileHistory(stdout) };
}

function parseBlame(output: string): GitBlameLine[] {
  const result: GitBlameLine[] = [];
  let current: Partial<GitBlameLine> | null = null;
  for (const line of output.split('\n')) {
    const header = line.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/);
    if (header) {
      current = {
        commit: header[1],
        originalLine: Number(header[2]),
        finalLine: Number(header[3]),
        line: Number(header[3]),
        author: '',
        authorMail: '',
        authorTime: '',
        summary: '',
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('author ')) current.author = line.slice('author '.length);
    else if (line.startsWith('author-mail ')) current.authorMail = line.slice('author-mail '.length);
    else if (line.startsWith('author-time ')) {
      current.authorTime = new Date(Number(line.slice('author-time '.length)) * 1000).toISOString();
    } else if (line.startsWith('summary ')) current.summary = line.slice('summary '.length);
    else if (line.startsWith('\t')) {
      result.push({
        line: current.line ?? result.length + 1,
        originalLine: current.originalLine ?? 0,
        finalLine: current.finalLine ?? result.length + 1,
        commit: current.commit ?? '',
        author: current.author ?? '',
        authorMail: current.authorMail ?? '',
        authorTime: current.authorTime ?? '',
        summary: current.summary ?? '',
        content: line.slice(1),
      });
      current = null;
    }
  }
  return result;
}

async function getBlame({
  projectPath,
  file,
  ref = 'HEAD',
  limit,
  signal,
}: BlameOptions): Promise<{ lines: GitBlameLine[]; truncated: boolean }> {
  await assertGitRepository(projectPath);
  await assertExistingCommitRef(projectPath, ref, 'blame', signal);
  const safeLimit = clampLimit(limit, MAX_BLAME_LINES, MAX_BLAME_LINES);
  const { stdout } = await runGit(
    projectPath,
    ['blame', '--line-porcelain', '-L', `1,+${safeLimit}`, ref, '--', file],
    readOnlyGitOptions({ signal }),
  );
  const lines = parseBlame(stdout);
  return { lines, truncated: lines.length >= safeLimit };
}

function parseGraph(output: string): GitGraphCommit[] {
  const commits: GitGraphCommit[] = [];
  for (const line of output.split('\n')) {
    const hashMatch = line.match(/[0-9a-f]{40}/);
    if (!hashMatch) continue;
    const graph = line.slice(0, hashMatch.index).trimEnd();
    const fields = line.slice(hashMatch.index).split('\0');
    const [hash = '', parents = '', decorations = '', author = '', date = '', subject = ''] = fields;
    commits.push({
      graph,
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      decorations: decorations
        ? decorations.split(',').map((entry) => entry.trim()).filter(Boolean)
        : [],
      author,
      date,
      subject,
    });
  }
  return commits;
}

async function getGraph({
  projectPath,
  limit,
  signal,
}: GraphOptions): Promise<{ commits: GitGraphCommit[] }> {
  await assertGitRepository(projectPath);
  const safeLimit = clampLimit(limit, 200, MAX_GRAPH_LIMIT);
  const { stdout } = await runGit(
    projectPath,
    [
      'log',
      '--graph',
      '--decorate',
      '--date=relative',
      '--pretty=format:%H%x00%P%x00%D%x00%an%x00%ad%x00%s',
      `-n${safeLimit}`,
    ],
    readOnlyGitOptions({ signal }),
  );
  return { commits: parseGraph(stdout) };
}

export function createPorcelainOperations() {
  return {
    getConflicts,
    getConflictDetails,
    acceptConflictSide,
    markConflictResolved,
    getStashes,
    createStash,
    applyStash,
    popStash,
    dropStash,
    getFileHistory,
    getBlame,
    getGraph,
  };
}
