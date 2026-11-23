import { GIT_ERROR_MESSAGE_LIMIT, GitDomainError } from './git-domain-error.js';
import { gitMutationDispatched, gitOutputTruncated, isGitCancellation } from './operation-context.js';
import { redactPushDiagnostic } from './push-diagnostic.js';
import { runGit } from './run.js';
import type { GitCommandOptions, GitCommandResult, GitProcessError } from './types.js';

// Pre-push hook output shares stdout with Git's per-URL porcelain reports.
const PUSH_REPORT_MAX_BYTES = 1024 * 1024;

// Destination continuations can look like report rows. Only fixed Git reasons are safe to quote.
const rejectionReasons = new Set([
  '[rejected] (non-fast-forward)', '[rejected] (fetch first)', '[rejected] (already exists)',
  '[rejected] (needs force)', '[rejected] (stale info)',
  '[remote rejected] (hook declined)', '[remote rejected] (pre-receive hook declined)',
]);

function parseRefStatus(line = '') {
  const [flag = '', pair, summary] = line.split('\t', 3);
  if (!/^[ *+=!-]$/.test(flag) || !pair?.includes(':refs/') || !summary) return;
  return { flag, pair, summary };
}

function readPushReport(stdout: string, refspec: string) {
  let confirmed = /(?:^|\n)Done\r?\n$/.test(stdout);
  const rejections = new Set<string>();
  const lines = stdout.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    let row = parseRefStatus(line);
    if (!row) {
      // A skipped URL's Done can follow hook text on the same line. A To header precedes a row.
      if (line.endsWith('Done') && !(line.startsWith('To ') && parseRefStatus(lines[index + 1]))) {
        confirmed = false;
      }
      index++;
      continue;
    }

    // A hook can print status rows of its own. Only Git's To/rows/Done frame counts.
    const hasHeader = index > 0 && lines[index - 1].startsWith('To ');
    const blockRejections = new Set<string>();
    let branchAccepted = false;
    while (row) {
      if (row.flag === '!') blockRejections.add(rejectionReasons.has(row.summary) ? row.summary : 'Git reported a rejected ref.');
      if (row.pair === refspec) branchAccepted = row.flag === '*' || row.flag === ' ' || row.flag === '=';
      index++;
      row = parseRefStatus(lines[index]);
    }
    if (hasHeader && lines[index] === 'Done' && index < lines.length - 1) {
      for (const reason of blockRejections) rejections.add(reason);
      if (!branchAccepted) confirmed = false;
    } else {
      confirmed = false;
    }
    index++;
  }
  return { confirmed, rejections };
}

function unconfirmedPush(rejections: Set<string>, detail: string, outcome: 'interrupted' | 'failed' | 'exited-zero'): GitDomainError {
  const lines = ['Git did not confirm the push. Inspect the remote before pushing again.'];
  if (outcome === 'interrupted') lines.push('Git push was cancelled or timed out.');
  if (gitOutputTruncated()) lines.push(`Git output exceeded ${PUSH_REPORT_MAX_BYTES} bytes and was truncated.`);
  else if (outcome === 'exited-zero') lines.push('Git exited successfully. Check for a skipped destination or pre-push hook output mixed into the report.');
  lines.push(...rejections);
  const notice = lines.join('\n');

  // Git and the receiver usually explain a failure after local hook output.
  const room = GIT_ERROR_MESSAGE_LIMIT - notice.length - 1;
  const excerpt = detail.length <= room ? detail : `...${detail.slice(-(room - 3))}`;
  return new GitDomainError('MUTATION_OUTCOME_UNKNOWN', excerpt ? `${notice}\n${excerpt}` : notice);
}

export async function pushBranchRef(projectPath: string, remote: string, ref: string, options: GitCommandOptions): Promise<void> {
  const refspec = `${ref}:${ref}`;
  // Git expands even full destinations. Wildcards exclude writable aliases without requiring them
  // in submodules; tags are left to Git's ordinary non-force and follow-tags rules.
  const excludedAliases = ['refs', 'refs/heads', 'refs/remotes'].map(prefix => `^${prefix}/${ref}*`);
  let result: GitCommandResult;
  let stderrTruncated = false;
  try {
    result = await runGit(projectPath, ['push', '--porcelain', remote, refspec, ...excludedAliases], {
      ...options, maxStdoutBytes: PUSH_REPORT_MAX_BYTES,
      onStderrTruncated: () => { stderrTruncated = true; },
    });
  } catch (error) {
    const failure: GitProcessError | undefined = error instanceof Error ? error : undefined;
    const stdout = typeof failure?.stdout === 'string' ? failure.stdout : undefined;
    const interrupted = isGitCancellation(error);
    if (!gitMutationDispatched() && (stdout === undefined || interrupted)) throw error;
    const { rejections } = readPushReport(stdout ?? '', refspec);
    const stderr = typeof failure?.stderr === 'string' ? failure.stderr : '';
    const completeStderr = !stderrTruncated && !interrupted && stderr.endsWith('\n');
    const detail = redactPushDiagnostic(stderr.trim(), completeStderr ? 'complete-stderr' : 'unverified');
    throw unconfirmedPush(rejections, detail, interrupted ? 'interrupted' : 'failed');
  }
  const { confirmed, rejections } = readPushReport(result.stdout, refspec);
  if (!confirmed || gitOutputTruncated()) {
    const detail = redactPushDiagnostic(result.stderr.trim(), 'unverified');
    throw unconfirmedPush(rejections, detail, 'exited-zero');
  }
}
