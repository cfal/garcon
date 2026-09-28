import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile } from 'node:fs/promises';
import { createTestDirectSessionStore, removeTestDirectSessionStores } from './session-store-fixture.ts';

const SESSION_ID = '00000000-0000-4000-8000-00000000abcd';
const RUNS = 4000;

afterEach(removeTestDirectSessionStores);

function runId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

describe('long Direct sessions', () => {
  test('load every record while yielding to the event loop between parse steps', async () => {
    const store = createTestDirectSessionStore();
    const created = await store.create({ sessionId: SESSION_ID, runId: runId(0), content: 'first', attachments: [] });
    let appended = `${JSON.stringify({ type: 'assistant', at: created.header.createdAt, runId: runId(0), content: 'answer 0', checkpoint: null })}\n`;
    for (let index = 1; index < RUNS; index += 1) {
      const at = created.header.createdAt;
      appended += `${JSON.stringify({ type: 'user', at, runId: runId(index), content: `request ${index}`, attachments: [] })}\n`;
      appended += `${JSON.stringify({ type: 'assistant', at, runId: runId(index), content: `answer ${index}`, checkpoint: null })}\n`;
    }
    await appendFile(created.path, appended);

    let turns = 0;
    let running = true;
    const tick = () => {
      if (!running) return;
      turns += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    const loaded = await store.load(SESSION_ID);
    running = false;

    expect(loaded.records).toHaveLength(RUNS * 2);
    expect(loaded.records.at(-1)).toMatchObject({ type: 'assistant', runId: runId(RUNS - 1), content: `answer ${RUNS - 1}` });
    expect(turns).toBeGreaterThan(3);
  });
});
