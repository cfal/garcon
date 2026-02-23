import { describe, it, expect } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  CODEX_SESSIONS_ROOT,
  findCodexSessionFileBySessionId,
  getCodexSessionMeta,
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

  it('getCodexSessionMeta extracts id/title/activity/cwd/model from jsonl', async () => {
    const filePath = path.join(os.tmpdir(), `codex-meta-${randomUUID()}.jsonl`);
    const t1 = '2026-02-20T10:00:00.000Z';
    const t2 = '2026-02-20T10:01:00.000Z';

    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/repo', model: 'gpt-5' } }),
      JSON.stringify({ type: 'event_msg', timestamp: t1, payload: { type: 'user_message', message: 'First prompt' } }),
      JSON.stringify({ type: 'event_msg', timestamp: t2, payload: { type: 'user_message', message: 'Second prompt' } }),
      JSON.stringify({
        type: 'response_item',
        timestamp: t2,
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Assistant reply' }] },
      }),
    ];

    await fs.writeFile(filePath, `${lines.join('\n')}\n`);

    try {
      const meta = await getCodexSessionMeta(filePath);
      expect(meta).toEqual({
        id: 's1',
        title: 'Second prompt',
        lastMessage: 'Assistant reply',
        lastActivity: t2,
        createdAt: t1,
        cwd: '/repo',
        model: 'gpt-5',
      });
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it('getCodexSessionMeta returns null when session_meta is missing', async () => {
    const filePath = path.join(os.tmpdir(), `codex-meta-empty-${randomUUID()}.jsonl`);
    await fs.writeFile(filePath, `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'x' } })}\n`);

    try {
      expect(await getCodexSessionMeta(filePath)).toBeNull();
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });
});
