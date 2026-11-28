import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach } from 'bun:test';
import { AntigravityAcpEventConverter } from '../../../../server-agents/antigravity/src/agents/antigravity/antigravity-acp-event-converter.ts';
import type { EventStep } from './event-converter.ts';
import { packLargeText } from './event-text-runs.ts';

const destination = process.env.GARCON_AGY_EVENT_INPUTS;
if (!destination) throw new Error('Set GARCON_AGY_EVENT_INPUTS to a scratch JSONL path.');
writeFileSync(destination, readFileSync(new URL('../inputs/event-converter-traps.jsonl', import.meta.url)));
let sessions = new Map<AntigravityAcpEventConverter, EventStep[]>();
const prototype = AntigravityAcpEventConverter.prototype;
for (const method of [
  'beginTurn', 'fromSessionUpdate', 'permissionToolUse', 'endTurn',
  'flushPending', 'takeTurnFailure', 'releaseSession',
] as const) {
  const original = prototype[method] as (this: AntigravityAcpEventConverter, ...args: unknown[]) => unknown;
  Object.defineProperty(prototype, method, {
    value(this: AntigravityAcpEventConverter, ...args: unknown[]) {
      let steps = sessions.get(this);
      if (!steps) sessions.set(this, steps = []);
      steps.push(packLargeText([method, ...args]) as EventStep);
      return original.apply(this, args);
    },
  });
}

afterEach(() => {
  for (const steps of sessions.values()) {
    appendFileSync(destination, JSON.stringify({ fn: 'scriptedAntigravityEvents', args: [steps] }) + '\n');
  }
  sessions = new Map();
});
