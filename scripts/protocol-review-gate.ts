import { execFileSync } from 'node:child_process';

const protocolFile = 'server/remote/transport/rpc-protocol.ts';
const sharedWireFiles = new Set([
  'common/agent-execution.ts', 'common/agent-integration.ts', 'common/agents.ts',
  'common/chat-types.ts', 'common/chat-message-coercion.ts', 'common/executors.ts',
  'common/agent-settings.ts', 'common/attachments.ts', 'common/chat-modes.ts',
  'common/cli-contracts.ts', 'common/http-error.ts',
]);

export function requiresProtocolReview(file: string): boolean {
  return sharedWireFiles.has(file)
    || /^server-agents\/interface\/src\/contracts\/.*\.ts$/.test(file)
    || /^server\/remote\/transport\/(?:.*-protocol|rpc-routing|websocket-link|message-session|session-socket)\.ts$/.test(file);
}

export function protocolRevision(source: string): number {
  const match = source.match(/^export const EXECUTOR_PROTOCOL_REVISION = (\d+);/m);
  if (!match) throw new Error('Cannot read EXECUTOR_PROTOCOL_REVISION');
  return Number(match[1]);
}

export function protocolReviewProblem(input: {
  files: readonly string[]; before: number; after: number; message: string;
}): string | null {
  if (input.after < input.before) return 'Executor protocol revision must not decrease';
  const files = input.files.filter(requiresProtocolReview);
  if (!files.length || input.after > input.before) return null;
  if (/^Protocol-Unchanged: \S.{9,}$/m.test(input.message)) return null;
  return `Wire-defining files changed without a protocol bump or a Protocol-Unchanged: <reason> commit trailer:\n${files.join('\n')}`;
}

if (import.meta.main) {
  const base = process.argv[2];
  const head = process.argv[3] ?? 'HEAD';
  if (!base) throw new Error('Usage: bun scripts/protocol-review-gate.ts <base> [head]');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const commonBase = git('merge-base', base, head);
  // Each wire-changing commit must explain itself; a trailer on unrelated work is insufficient.
  const commits = git('rev-list', '--reverse', '--no-merges', `${commonBase}..${head}`).split('\n').filter(Boolean);
  for (const commit of commits) {
    const problem = protocolReviewProblem({
      files: git('diff-tree', '--no-commit-id', '--name-only', '-r', commit).split('\n'),
      before: protocolRevision(git('show', `${commit}^:${protocolFile}`)),
      after: protocolRevision(git('show', `${commit}:${protocolFile}`)),
      message: git('show', '-s', '--format=%B', commit),
    });
    if (problem) throw new Error(`${commit}: ${problem}`);
  }
  console.log(`Protocol review checked ${commits.length} commit(s).`);
}
