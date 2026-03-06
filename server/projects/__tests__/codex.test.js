import { describe, it, expect } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  CODEX_SESSIONS_ROOT,
  findCodexSessionFileBySessionId,
} from '../codex.js';

describe('codex project helpers', () => {
  it('findCodexSessionFileBySessionId finds a nested rollout file by UUID suffix', async () => {
    const sessionId = `sid-${randomUUID()}`;
    const testRoot = path.join(CODEX_SESSIONS_ROOT, `__test-${sessionId}`);
    const nestedDir = path.join(testRoot, 'nested', 'deep');
    const filePath = path.join(nestedDir, `rollout-123-${sessionId}.jsonl`);

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(filePath, '{}\n');

    try {
      const found = await findCodexSessionFileBySessionId(sessionId);
      expect(found).toBe(filePath);
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });

  it('findCodexSessionFileBySessionId returns null for empty input', async () => {
    expect(await findCodexSessionFileBySessionId('')).toBeNull();
    expect(await findCodexSessionFileBySessionId(null)).toBeNull();
  });
});
