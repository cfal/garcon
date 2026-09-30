import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { loadCodexChatMessages } from '../history-loader.js';

// Long enough that finishing it in one pass would hold the event loop well past the limit.
const TURNS = 60_000;
const MAX_GAP_MS = 50;

function syntheticRollout() {
  const lines = [];
  for (let index = 0; index < TURNS; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    lines.push(JSON.stringify({
      type: 'event_msg',
      timestamp,
      payload: { type: 'user_message', message: `Synthetic request ${index}` },
    }));
    lines.push(JSON.stringify({
      type: 'response_item',
      timestamp,
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Synthetic answer ${index}` }] },
    }));
  }
  return lines;
}

describe('long Codex rollout history', () => {
  it('loads every message in rollout order without holding the event loop for the whole file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-long-history-'));
    const filePath = path.join(directory, 'rollout.jsonl');
    await fs.writeFile(filePath, `${syntheticRollout().join('\n')}\n`, 'utf8');
    try {
      let last = performance.now();
      let longestGap = 0;
      const probe = setInterval(() => {
        const now = performance.now();
        longestGap = Math.max(longestGap, now - last);
        last = now;
      }, 1);
      const loaded = await loadCodexChatMessages(filePath, undefined, { throwOnError: true });
      // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
      await new Promise((resolve) => setTimeout(resolve, 5));
      clearInterval(probe);

      expect(loaded.map((message) => [message.type, message.content])).toEqual(
        Array.from({ length: TURNS }, (_, index) => [
          ['user-message', `Synthetic request ${index}`],
          ['assistant-message', `Synthetic answer ${index}`],
        ]).flat(),
      );
      expect(longestGap).toBeLessThan(MAX_GAP_MS);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
