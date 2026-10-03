import { describe, expect, it, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { loadPiChatMessages } from '../history-loader.js';

const TURNS = 20_000;

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

function syntheticSession(compacted) {
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
  if (compacted) {
    entries.push({ type: 'compaction', id: 'compaction', parentId, timestamp: '2026-01-02T00:00:00.000Z',
      summary: 'Synthetic summary', firstKeptEntryId: `user-${TURNS / 2}`, tokensBefore: 100_000 });
    entries.push({ type: 'context_edit', id: 'edit', parentId: 'compaction', timestamp: '2026-01-02T00:00:01.000Z',
      targetId: `assistant-${TURNS - 1}`, replacement: { content: 'Synthetic edited answer' } });
  }
  return entries;
}

describe('long Pi native history', () => {
  it.each([['plain', false], ['compacted', true]])('bounds active-path work between event-loop turns (%s)', async (_name, compacted) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-long-history-'));
    const sessionPath = path.join(directory, 'session.jsonl');
    await fs.writeFile(sessionPath, `${syntheticSession(compacted).map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    let clock = 0;
    let lastTurn = 0;
    let longestStep = 0;
    // Charges deterministic work per entry access, not runner scheduling or GC pauses.
    const now = spyOn(performance, 'now').mockImplementation(() => clock);
    const parse = JSON.parse;
    const parsing = spyOn(JSON, 'parse').mockImplementation((text, reviver) => new Proxy(parse(text, reviver), {
      get(target, key, receiver) {
        clock += 1;
        longestStep = Math.max(longestStep, clock - lastTurn);
        return Reflect.get(target, key, receiver);
      },
    }));
    let probe;
    const tick = () => {
      lastTurn = clock;
      probe = setImmediate(tick);
    };
    probe = setImmediate(tick);
    try {
      const loaded = await loadPiChatMessages(sessionPath);

      expect(loaded).toHaveLength(compacted ? TURNS : TURNS * 2);
      expect(loaded[0]).toMatchObject({ type: 'user-message', content: `Synthetic request ${compacted ? TURNS / 2 : 0}` });
      expect(loaded.at(-1)).toMatchObject({ type: 'assistant-message',
        content: compacted ? 'Synthetic edited answer' : `Synthetic answer ${TURNS - 1}` });
      expect(clock).toBeGreaterThan(TURNS * 2);
      expect(longestStep).toBeLessThan(50);
    } finally {
      clearImmediate(probe);
      parsing.mockRestore();
      now.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
