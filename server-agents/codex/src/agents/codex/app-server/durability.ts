import { promises as fs } from 'fs';
import type { CodexThread } from './protocol.js';

export interface MaterializedThreadOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function waitForMaterializedThread(
  thread: Pick<CodexThread, 'id' | 'path'>,
  {
    timeoutMs = 10_000,
    pollIntervalMs = 250,
  }: MaterializedThreadOptions = {},
): Promise<string> {
  if (!thread.path) {
    throw new Error(`Codex thread ${thread.id} did not report a native transcript path`);
  }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (await fileExists(thread.path)) {
      return thread.path;
    }
    await sleep(Math.max(1, pollIntervalMs));
  }

  throw new Error(`Codex thread ${thread.id} did not materialize transcript at ${thread.path}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
