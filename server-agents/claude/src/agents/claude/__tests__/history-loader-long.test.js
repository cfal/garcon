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

const ENTRY_PAIRS = 3000;

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
  it('matches whole-file conversion while yielding to the event loop between chunks', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-long-history-'));
    const filePath = path.join(directory, 'session.jsonl');
    const lines = syntheticTranscript();
    await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
    try {
      let turns = 0;
      let running = true;
      const tick = () => {
        if (!running) return;
        turns += 1;
        setImmediate(tick);
      };
      setImmediate(tick);
      const loaded = await loadClaudeChatMessages(filePath, undefined, { throwOnError: true });
      running = false;

      const expected = convertClaudeEntries(sortClaudeEntries(lines
        .map((line, index) => parseClaudeJsonlEntryWithSource(line, index + 1))
        .filter(Boolean)));
      expect(loaded).toHaveLength(ENTRY_PAIRS * 2);
      expect(loaded).toEqual(expected);
      expect(turns).toBeGreaterThan(10);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
