import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  convertClaudeEntries,
  loadClaudeChatMessages,
  parseClaudeJsonlEntryWithSource,
  sortClaudeEntries,
} from '../history-loader.js';

// Long enough that converting it in one pass would hold the event loop well past the limit.
const ENTRY_PAIRS = 20_000;
const MAX_GAP_MS = 50;

function syntheticTranscript() {
  const lines = [];
  for (let index = 0; index < ENTRY_PAIRS; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    lines.push(JSON.stringify({
      sessionId: 'session-long',
      type: 'user',
      uuid: `00000000-0000-4000-8000-${String(index * 2).padStart(12, '0')}`,
      timestamp,
      message: { role: 'user', content: `Synthetic request ${index} ${'generic words '.repeat(40)}` },
    }));
    lines.push(JSON.stringify({
      sessionId: 'session-long',
      type: 'assistant',
      uuid: `00000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, '0')}`,
      timestamp,
      message: { role: 'assistant', content: [{ type: 'text', text: `Synthetic answer ${index}` }] },
    }));
  }
  return lines;
}

describe('long Claude native history', () => {
  it('matches whole-file conversion without holding the event loop for the whole file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-long-history-'));
    const filePath = path.join(directory, 'session.jsonl');
    const lines = syntheticTranscript();
    await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
    try {
      let last = performance.now();
      let longestGap = 0;
      const probe = setInterval(() => {
        const now = performance.now();
        longestGap = Math.max(longestGap, now - last);
        last = now;
      }, 1);
      const loaded = await loadClaudeChatMessages(filePath, undefined, { throwOnError: true });
      // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
      await new Promise((resolve) => setTimeout(resolve, 5));
      clearInterval(probe);

      const expected = convertClaudeEntries(sortClaudeEntries(lines
        .map((line, index) => parseClaudeJsonlEntryWithSource(line, index + 1))
        .filter(Boolean)));
      expect(loaded).toHaveLength(ENTRY_PAIRS * 2);
      expect(loaded).toEqual(expected);
      expect(longestGap).toBeLessThan(MAX_GAP_MS);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
