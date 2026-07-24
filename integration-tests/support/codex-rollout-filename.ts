const ROLLOUT_PATTERN =
  /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface ParsedCodexRolloutFileName {
  readonly createdAt: Date;
  readonly threadId: string;
}

export function parseCodexRolloutFileName(fileName: string): ParsedCodexRolloutFileName | null {
  const match = ROLLOUT_PATTERN.exec(fileName);
  if (!match) return null;
  const timestamp = match[1]!;
  const createdAt = new Date(
    `${timestamp.slice(0, 13)}:${timestamp.slice(14, 16)}:${timestamp.slice(17)}Z`,
  );
  if (Number.isNaN(createdAt.getTime()) || formatCodexRolloutTimestamp(createdAt) !== timestamp) {
    return null;
  }
  return { createdAt, threadId: match[2]!.toLowerCase() };
}

export function createCodexRolloutFileName(threadId: string, createdAt: Date): string {
  if (!ROLLOUT_PATTERN.test(`rollout-2000-01-01T00-00-00-${threadId}.jsonl`)) {
    throw new TypeError('Codex rollout thread id must be a UUID');
  }
  if (Number.isNaN(createdAt.getTime())) {
    throw new TypeError('Codex rollout creation time must be a valid date');
  }
  return `rollout-${formatCodexRolloutTimestamp(createdAt)}-${threadId.toLowerCase()}.jsonl`;
}

function formatCodexRolloutTimestamp(createdAt: Date): string {
  return createdAt.toISOString().slice(0, 19).replaceAll(':', '-');
}
