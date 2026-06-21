import { promises as fs } from 'fs';
import {
  assertGitRepository,
  resolvePathWithinProject,
  runGit,
} from './run.js';
import type {
  BlameOptions,
  CompareOptions,
  ConflictAcceptOptions,
  ConflictDetailsOptions,
  FileHistoryOptions,
  FileOptions,
  GitBlameLine,
  GitCompareFile,
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

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) return fallback;
  return Math.min(value, max);
}

function assertSafeRef(ref: string, label: string): void {
  if (
    !ref ||
    ref.includes('..') ||
    ref.includes(':') ||
    /[\s\0-\x1f\x7f]/.test(ref) ||
    !/^[A-Za-z0-9._/@{}~^+-]+$/.test(ref)
  ) {
    throw new GitDomainError('INVALID_INPUT', `Invalid ${label} ref.`);
  }
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

async function stageBlobAvailable(
  projectPath: string,
  stage: 1 | 2 | 3,
  file: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await runGit(projectPath, ['show', `:${stage}:${file}`], { signal });
    return true;
  } catch {
    return false;
  }
}

async function readStageBlob(
  projectPath: string,
  stage: 1 | 2 | 3,
  file: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(projectPath, ['show', `:${stage}:${file}`], { signal });
    return stdout;
  } catch {
    return null;
  }
}

async function getConflicts({
  projectPath,
  signal,
}: ProjectOptions): Promise<{ conflicts: GitConflictFile[] }> {
  await assertGitRepository(projectPath);
  const { stdout } = await runGit(projectPath, ['status', '--porcelain=v1', '-z', '-uall'], { signal });
  const conflicts: GitConflictFile[] = [];
  for (const entry of parsePorcelainStatus(stdout)) {
    if (!UNMERGED_STATUSES.has(entry.status as GitConflictStatus)) continue;
    conflicts.push({
      path: entry.path,
      status: entry.status as GitConflictStatus,
      baseAvailable: await stageBlobAvailable(projectPath, 1, entry.path, signal),
      oursAvailable: await stageBlobAvailable(projectPath, 2, entry.path, signal),
      theirsAvailable: await stageBlobAvailable(projectPath, 3, entry.path, signal),
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
  const workingPath = resolvePathWithinProject(projectPath, file);
  let working = '';
  try {
    working = await fs.readFile(workingPath, 'utf-8');
  } catch {
    working = '';
  }
  return {
    path: file,
    base: await readStageBlob(projectPath, 1, file, signal),
    ours: await readStageBlob(projectPath, 2, file, signal),
    theirs: await readStageBlob(projectPath, 3, file, signal),
    working,
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
    { signal },
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
    { signal },
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
  assertSafeRef(ref, 'blame');
  await assertGitRepository(projectPath);
  const safeLimit = clampLimit(limit, MAX_BLAME_LINES, MAX_BLAME_LINES);
  const { stdout } = await runGit(
    projectPath,
    ['blame', '--line-porcelain', '-L', `1,+${safeLimit}`, ref, '--', file],
    { signal },
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
    { signal },
  );
  return { commits: parseGraph(stdout) };
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [additionsRaw = '0', deletionsRaw = '0', filePath = ''] = line.split('\t');
    stats.set(filePath, {
      additions: additionsRaw === '-' ? 0 : Number(additionsRaw) || 0,
      deletions: deletionsRaw === '-' ? 0 : Number(deletionsRaw) || 0,
    });
  }
  return stats;
}

function parseNameStatus(output: string, stats: Map<string, { additions: number; deletions: number }>): GitCompareFile[] {
  const files: GitCompareFile[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const status = fields[0] ?? '';
    const path = status.startsWith('R') || status.startsWith('C') ? fields[2] : fields[1];
    const originalPath = status.startsWith('R') || status.startsWith('C') ? fields[1] : undefined;
    if (!path) continue;
    const fileStats = stats.get(path) ?? { additions: 0, deletions: 0 };
    files.push({
      path,
      status,
      originalPath,
      additions: fileStats.additions,
      deletions: fileStats.deletions,
    });
  }
  return files;
}

async function getCompare({
  projectPath,
  base,
  head,
  signal,
}: CompareOptions): Promise<{ files: GitCompareFile[] }> {
  assertSafeRef(base, 'base');
  assertSafeRef(head, 'head');
  await assertGitRepository(projectPath);
  const range = `${base}...${head}`;
  const [nameStatus, numstat] = await Promise.all([
    runGit(projectPath, ['diff', '--name-status', '--find-renames', range], { signal }),
    runGit(projectPath, ['diff', '--numstat', '--find-renames', range], { signal }),
  ]);
  return { files: parseNameStatus(nameStatus.stdout, parseNumstat(numstat.stdout)) };
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
    getCompare,
  };
}
