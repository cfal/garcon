import path from 'node:path';
import type { ForkJsonlTargetPathInput } from '@garcon/server-agent-common/forking/fork-jsonl';

export function createCodexForkTargetPath(input: ForkJsonlTargetPathInput): string {
  if (Number.isNaN(input.createdAt.getTime())) {
    throw new TypeError('Codex fork creation time must be a valid date');
  }
  const timestamp = input.createdAt.toISOString().slice(0, 19).replaceAll(':', '-');
  return path.join(
    path.dirname(input.sourcePath),
    `rollout-${timestamp}-${input.targetAgentSessionId}.jsonl`,
  );
}
