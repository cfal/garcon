import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach } from 'bun:test';
import { CursorAcpEventConverter } from '../../../../server-agents/cursor/src/agents/cursor/cursor-acp-event-converter.ts';
import type { EventStep } from './event-converter.ts';

const destination = process.env.GARCON_CURSOR_EVENT_INPUTS;
if (!destination) throw new Error('Set GARCON_CURSOR_EVENT_INPUTS to a scratch JSONL path.');
writeFileSync(destination, readFileSync(new URL('../inputs/event-converter-traps.jsonl', import.meta.url)));
let sessions = new Map<CursorAcpEventConverter, EventStep[]>();
const prototype = CursorAcpEventConverter.prototype;
for (const method of [
  'beginTurn', 'endTurn', 'permissionToolUse', 'customRequestToolUse', 'fromSessionUpdate', 'releaseSession',
] as const) {
  const original = prototype[method] as (this: CursorAcpEventConverter, ...args: unknown[]) => unknown;
  Object.defineProperty(prototype, method, {
    value(this: CursorAcpEventConverter, ...args: unknown[]) {
      let steps = sessions.get(this);
      if (!steps) sessions.set(this, steps = []);
      const step = JSON.parse(JSON.stringify([method, ...args])) as EventStep;
      if (step[0] !== 'beginTurn' && step[0] !== 'releaseSession') {
        step[2] = { chatId: 'chat-1', sessionId: step[2].sessionId, timestamp: 'stamp' };
      }
      steps.push(step);
      return original.apply(this, args);
    },
  });
}

afterEach(() => {
  for (const steps of sessions.values()) {
    appendFileSync(destination, JSON.stringify({ fn: 'scriptedCursorEvents', args: [steps] }) + '\n');
  }
  sessions = new Map();
});
