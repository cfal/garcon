import { describe, it, expect, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  CODEX_SESSIONS_ROOT,
  findCodexSessionFileBySessionId,
} from '../codex.js';

describe('Codex path lookup', () => {
  it('finds a nested rollout file by UUID suffix', async () => {
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

  it('returns null for empty input', async () => {
    expect(await findCodexSessionFileBySessionId('')).toBeNull();
    expect(await findCodexSessionFileBySessionId(null)).toBeNull();
  });

  it('waits briefly for a delayed rollout file to appear', async () => {
    const sessionId = `sid-${randomUUID()}`;
    const testRoot = path.join(CODEX_SESSIONS_ROOT, `__test-${sessionId}`);
    const nestedDir = path.join(testRoot, 'nested', 'deep');
    const filePath = path.join(nestedDir, `rollout-123-${sessionId}.jsonl`);
    const infoSpy = mock(() => undefined);
    const warnSpy = mock(() => undefined);
    const originalInfo = console.info;
    const originalWarn = console.warn;
    console.info = infoSpy;
    console.warn = warnSpy;

    await fs.mkdir(nestedDir, { recursive: true });
    const delayedWrite = new Promise((resolve, reject) => {
      setTimeout(() => {
        fs.writeFile(filePath, '{}\n').then(resolve, reject);
      }, 30);
    });

    try {
      const found = await findCodexSessionFileBySessionId(sessionId, {
        waitTimeoutMs: 200,
        pollIntervalMs: 10,
      });

      expect(found).toBe(filePath);
      expect(infoSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).not.toHaveBeenCalled();
      await delayedWrite;
    } finally {
      console.info = originalInfo;
      console.warn = originalWarn;
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });

  it('logs a timeout when the rollout file never appears', async () => {
    const sessionId = `sid-${randomUUID()}`;
    const infoSpy = mock(() => undefined);
    const warnSpy = mock(() => undefined);
    const originalInfo = console.info;
    const originalWarn = console.warn;
    console.info = infoSpy;
    console.warn = warnSpy;

    try {
      const found = await findCodexSessionFileBySessionId(sessionId, {
        waitTimeoutMs: 25,
        pollIntervalMs: 10,
      });

      expect(found).toBeNull();
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      console.info = originalInfo;
      console.warn = originalWarn;
    }
  });
});
