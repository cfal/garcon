import type { GitOperationDiagnostics } from '../../../../common/git-diagnostics.ts';
import type { GitRefsResponse } from '../../../../common/git-refs.ts';
import type { SlashCommandsResponse } from '../../../../common/slash-commands.ts';

const diagnostics: GitOperationDiagnostics = {
  phases: [{ name: 'summary-git', durationMs: 1.25 }, { name: 'body-cache', durationMs: 0 }],
  cacheHits: 2,
  batchCount: 1,
  bisectionCount: undefined,
  fileCount: 7,
  rowCount: 0,
  commands: [{ command: 'status', durationMs: 1e-7, stdoutBytes: 30, stderrBytes: 0 }],
};
const refs: GitRefsResponse = {
  refs: [
    { name: 'main', ref: 'refs/heads/main', kind: 'local-branch', updatedAt: '2026-01-01T00:00:00.000Z', isCurrent: true },
    { name: 'origin/main', ref: 'refs/remotes/origin/main', kind: 'remote-branch', updatedAt: null, isCurrent: false },
    { name: 'v1', ref: 'refs/tags/v1', kind: 'tag', updatedAt: null },
  ],
};
const slashCommands: SlashCommandsResponse = {
  commands: [
    { name: 'compact', source: 'command' },
    { name: 'review', source: 'skill', description: 'Review the current changes.' },
  ],
};

for (const value of [diagnostics, refs, slashCommands]) console.log(JSON.stringify(value));
