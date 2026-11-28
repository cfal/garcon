import type { GitDiffPatchFile } from '../../../../server/runtime/gh/pull-request-diff.js';

// These values enter the mapper from the typed patch parser, not gh JSON.
export function isPatchList(value: GitDiffPatchFile[]): boolean {
  return Array.isArray(value) && value.every(file =>
    typeof file.path === 'string' && typeof file.status === 'string'
    && ['normal', 'generated', 'lockfile', 'binary', 'large'].includes(file.body.category)
    && ['unloaded', 'loading', 'loaded', 'binary', 'too-large', 'error'].includes(file.body.bodyState)
  );
}
