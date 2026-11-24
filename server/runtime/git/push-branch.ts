import { GitDomainError } from './git-domain-error.js';
import { gitMutationDispatched, gitOutputTruncated, isGitCancellation } from './operation-context.js';
import { runGit } from './run.js';
import type { GitCommandOptions, GitProcessError } from './types.js';

// Pre-push hook output shares stdout with Git's per-URL porcelain reports.
const PUSH_REPORT_MAX_BYTES = 1024 * 1024;

// Destination continuations can look like report rows. Only fixed Git reasons are safe to quote.
const rejectionReasons = new Set([
  '[rejected] (non-fast-forward)', '[rejected] (fetch first)', '[rejected] (already exists)',
  '[rejected] (needs force)', '[rejected] (stale info)',
  '[remote rejected] (hook declined)', '[remote rejected] (pre-receive hook declined)',
]);

function parseRefStatus(line = '') {
  const [flag = '', pair, summary, extra] = line.split('\t', 4);
  if (!/^[ *+=!-]$/.test(flag) || !pair?.includes(':refs/') || !summary) return;
  const rejection = flag === '!' && extra === undefined && rejectionReasons.has(summary) ? summary : undefined;
  return { flag, pair, rejection };
}

function readPushReport(stdout: string, refspec: string) {
  const lines = stdout.split(/\r?\n/);
  let confirmed = lines.at(-2) === 'Done' && lines.at(-1) === '';
  const rejections = new Set<string>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index++];
    let row = line.startsWith('To ') ? parseRefStatus(lines[index]) : undefined;
    if (!row) {
      // A skipped destination's Done can share a line with hook output.
      if (line.endsWith('Done') || parseRefStatus(line)) confirmed = false;
      continue;
    }

    const blockRejections = new Set<string>();
    let branchAccepted = false;
    while (row) {
      if (row.rejection) blockRejections.add(row.rejection);
      if (row.pair === refspec) branchAccepted = row.flag === '*' || row.flag === ' ' || row.flag === '=';
      index++;
      row = parseRefStatus(lines[index]);
    }
    if (lines[index] !== 'Done' || index === lines.length - 1) {
      confirmed = false;
      continue;
    }
    index++;
    for (const reason of blockRejections) rejections.add(reason);
    if (!branchAccepted) confirmed = false;
  }
  return { confirmed, rejections };
}

export async function pushBranchRef(projectPath: string, remote: string, ref: string, options: GitCommandOptions): Promise<void> {
  const refspec = `${ref}:${ref}`;
  // Git expands even full destinations. Wildcards exclude writable aliases without requiring them
  // in submodules; tags are left to Git's ordinary non-force and follow-tags rules.
  const excludedAliases = ['refs', 'refs/heads', 'refs/remotes'].map(prefix => `^${prefix}/${ref}*`);
  let stdout: string;
  let exit: 'exited-zero' | 'failed' | 'interrupted';
  try {
    const result = await runGit(projectPath, ['push', '--porcelain', remote, refspec, ...excludedAliases], {
      ...options, maxStdoutBytes: PUSH_REPORT_MAX_BYTES, maxStderrBytes: 0,
    });
    stdout = result.stdout;
    exit = 'exited-zero';
  } catch (error) {
    const failure: GitProcessError | undefined = error instanceof Error ? error : undefined;
    const captured = typeof failure?.stdout === 'string' ? failure.stdout : undefined;
    const interrupted = isGitCancellation(error);
    if (!gitMutationDispatched() && (captured === undefined || interrupted)) throw error;
    stdout = captured ?? '';
    exit = interrupted ? 'interrupted' : 'failed';
  }

  const { confirmed, rejections } = readPushReport(stdout, refspec);
  const truncated = gitOutputTruncated();
  if (exit === 'exited-zero' && confirmed && !truncated) return;

  const lines = ['Git did not confirm the push. Inspect the remote before pushing again.'];
  if (exit === 'interrupted') lines.push('Git push was cancelled or timed out.');
  if (truncated) lines.push('Git push output was truncated.');
  throw new GitDomainError('MUTATION_OUTCOME_UNKNOWN', [...lines, ...rejections].join('\n'));
}
