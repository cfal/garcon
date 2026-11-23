import { errorMessage } from '../../common/errors.js';
import { GIT_ERROR_MESSAGE_LIMIT, GitDomainError, redactGitDiagnostic } from './git-domain-error.js';
import { gitMutationDispatched, gitOutputTruncated, isGitCancellation } from './operation-context.js';
import { runGit } from './run.js';
import type { GitCommandOptions, GitCommandResult } from './types.js';

// Pre-push hook output shares stdout with Git's per-URL porcelain reports.
const PUSH_REPORT_MAX_BYTES = 1024 * 1024;

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
      if (line.endsWith('Done') && !(line.includes('To ') && parseRefStatus(lines[index + 1]))) {
        confirmed = false;
      }
      index++;
      continue;
    }

    // One destination's report is a consecutive block of rows followed immediately by Done.
    let branchAccepted = false;
    while (row) {
      if (row.flag === '!') rejections.add(row.summary);
      if (row.pair === refspec) branchAccepted = row.flag === '*' || row.flag === ' ' || row.flag === '=';
      index++;
      row = parseRefStatus(lines[index]);
    }
    if (!branchAccepted || lines[index] !== 'Done') confirmed = false;
    index++;
  }
  return { confirmed, rejections };
}

function unconfirmedPush(rejections: Set<string>, diagnostic: string): GitDomainError {
  const lines = ['Git did not confirm the push. Inspect the remote before pushing again.'];
  if (gitOutputTruncated()) lines.push(`Git output exceeded ${PUSH_REPORT_MAX_BYTES} bytes and was truncated.`);
  const summaries = redactGitDiagnostic([...rejections].join('\n')).slice(0, GIT_ERROR_MESSAGE_LIMIT / 4);
  if (summaries) lines.push(summaries);
  const notice = lines.join('\n');

  // Git and the receiver usually explain a failure after local hook output. Redact before excerpting.
  const detail = redactGitDiagnostic(diagnostic.trim());
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
  try {
    result = await runGit(projectPath, ['push', '--porcelain', remote, refspec, ...excludedAliases], {
      ...options, maxStdoutBytes: PUSH_REPORT_MAX_BYTES,
    });
  } catch (error) {
    const stdout = error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : undefined;
    if (!gitMutationDispatched() && (stdout === undefined || isGitCancellation(error))) throw error;
    const { rejections } = readPushReport(stdout ?? '', refspec);
    throw unconfirmedPush(rejections, errorMessage(error));
  }
  const { confirmed, rejections } = readPushReport(result.stdout, refspec);
  if (!confirmed || gitOutputTruncated()) throw unconfirmedPush(rejections, result.stderr);
}
