import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { loadPiChatMessages } from '../history-loader.js';

// Long enough that reading it in one pass would hold the event loop well past the limit.
const TURNS = 20_000;
const MAX_GAP_MS = 50;

function assistantMessage(text, timestamp) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'anthropic',
    model: 'claude-test',
    api: 'anthropic-messages',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  };
}

function syntheticSession() {
  const entries = [{ type: 'session', version: 3, id: 'session-long', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/project' }];
  let parentId = null;
  for (let turn = 0; turn < TURNS; turn += 1) {
    const at = new Date(Date.UTC(2026, 0, 1) + turn * 1000);
    entries.push({
      type: 'message',
      id: `user-${turn}`,
      parentId,
      timestamp: at.toISOString(),
      message: { role: 'user', content: `Synthetic request ${turn}`, timestamp: at.getTime() },
    });
    entries.push({
      type: 'message',
      id: `assistant-${turn}`,
      parentId: `user-${turn}`,
      timestamp: at.toISOString(),
      message: assistantMessage(`Synthetic answer ${turn}`, at.getTime()),
    });
    parentId = `assistant-${turn}`;
  }
  return entries;
}

describe('long Pi native history', () => {
  it('loads every message on the active path without holding the event loop for the whole file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-long-history-'));
    const sessionPath = path.join(directory, 'session.jsonl');
    await fs.writeFile(sessionPath, `${syntheticSession().map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    try {
      let last = performance.now();
      let longestGap = 0;
      const probe = setInterval(() => {
        const now = performance.now();
        longestGap = Math.max(longestGap, now - last);
        last = now;
      }, 1);
      const loaded = await loadPiChatMessages(sessionPath);
      // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
      await new Promise((resolve) => setTimeout(resolve, 5));
      clearInterval(probe);

      expect(loaded).toHaveLength(TURNS * 2);
      expect(loaded[0]).toMatchObject({ type: 'user-message', content: 'Synthetic request 0' });
      expect(loaded.at(-1)).toMatchObject({ type: 'assistant-message', content: `Synthetic answer ${TURNS - 1}` });
      expect(longestGap).toBeLessThan(MAX_GAP_MS);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
