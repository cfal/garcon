import { nulRecords } from './log-records.js';
import { assertExistingCommitRef } from './ref-validation.js';
import {
  assertGitRepository,
  readOnlyGitOptions,
  runGit
} from './run.js';
import type {
  BlameOptions,
  FileHistoryOptions,
  GitBlameLine,
  GitFileHistoryEntry,
  GitGraphCommit,
  GraphOptions
} from './types.js';


const MAX_HISTORY_LIMIT = 200;
const MAX_BLAME_LINES = 2_000;
const MAX_GRAPH_LIMIT = 500;

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) return fallback;
  return Math.min(value, max);
}

function parseFileHistory(output: string): GitFileHistoryEntry[] {
  return nulRecords(output, 5, 'file history').map(([hash, author, email, date, subject]) => ({ hash, author, email, date, subject }));
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
    ['log', '--follow', '-z', `-n${safeLimit}`, '--format=%H%x00%an%x00%ae%x00%ai%x00%s', '--', file],
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

export function createFileHistoryOperations() {
  return { getFileHistory, getBlame, getGraph };
}
