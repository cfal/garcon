import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { loadFactoryChatMessages } from '../history-loader.js';

// Long enough that converting it in one pass would hold the event loop well past the limit.
const TURNS = 20_000;
const MAX_GAP_MS = 50;

function syntheticSessionLines() {
  const lines = [JSON.stringify({ type: 'session_start', id: 'synthetic-session' })];
  for (let turn = 0; turn < TURNS; turn += 1) {
    lines.push(JSON.stringify({
      type: 'message',
      id: `user-${turn}`,
      timestamp: '2026-07-04T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: `Synthetic request ${turn} ${'generic words '.repeat(10)}` }] },
    }));
    lines.push(JSON.stringify({
      type: 'message',
      id: `assistant-${turn}`,
      timestamp: '2026-07-04T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `Synthetic answer ${turn}` },
          { type: 'tool_use', id: `tool-${turn}`, name: 'Read', input: { file_path: `/tmp/synthetic-${turn}.ts` } },
        ],
      },
    }));
  }
  return lines;
}

describe('long Factory sessions', () => {
  it('load every message without holding the event loop for the whole session', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-long-history-'));
    const sessionPath = path.join(directory, 'session.jsonl');
    await fs.writeFile(sessionPath, `${syntheticSessionLines().join('\n')}\n`, 'utf8');
    try {
      let last = performance.now();
      let longestGap = 0;
      const probe = setInterval(() => {
        const now = performance.now();
        longestGap = Math.max(longestGap, now - last);
        last = now;
      }, 1);
      const messages = await loadFactoryChatMessages(sessionPath, undefined, { throwOnError: true });
      // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
      await new Promise((resolve) => setTimeout(resolve, 5));
      clearInterval(probe);

      expect(messages).toHaveLength(TURNS * 3);
      expect(messages[0]).toMatchObject({ type: 'user-message' });
      expect(messages.at(-2)).toMatchObject({ type: 'assistant-message', content: `Synthetic answer ${TURNS - 1}` });
      expect(longestGap).toBeLessThan(MAX_GAP_MS);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
