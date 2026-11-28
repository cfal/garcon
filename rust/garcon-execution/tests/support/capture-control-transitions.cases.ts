import { afterAll, mock } from 'bun:test';
import * as transitions from '../../../../server/controller/chat-execution/chat-execution-control-transitions.ts';
import type { TransitionContext } from '../../../../server/controller/chat-execution/chat-execution-control-transitions.ts';

const destination = process.env.GARCON_EXECUTION_CONTROL_INPUTS;
if (!destination) throw new Error('Set GARCON_EXECUTION_CONTROL_INPUTS to the generated input path');

const captured = new Set<string>();
let large = 0;

function aboveRecorderLimit(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 1_000_000;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(aboveRecorderLimit);
}

const wrapped = Object.fromEntries(Object.entries(transitions).map(([name, transition]) => [
  name,
  (...args: unknown[]) => {
    const context = args.pop() as TransitionContext;
    const ids: string[] = [];
    const receiptKeys: string[][] = [];
    const result = (transition as (...args: unknown[]) => unknown)(...args, {
      now: context.now,
      newId: () => {
        const id = context.newId();
        ids.push(id);
        return id;
      },
      unsettledQueueReceiptKeys: () => {
        const keys = context.unsettledQueueReceiptKeys();
        receiptKeys.push([...keys]);
        return keys;
      },
    });
    if (aboveRecorderLimit(args)) large += 1;
    else captured.add(JSON.stringify({ fn: 'replayControlTransition',
      args: [name, args, context.now, ids, receiptKeys] }));
    return result;
  },
]));

mock.module('../../../../server/controller/chat-execution/chat-execution-control-transitions.ts',
  () => wrapped);

await import('../../../../server/controller/chat-execution/__tests__/chat-execution-control-transitions.test.js');

afterAll(async () => {
  const extra = await Bun.file(new URL('../inputs/transition-boundaries.jsonl', import.meta.url)).text();
  await Bun.write(destination, [...captured, extra.trimEnd()].join('\n') + '\n');
  console.log(`Captured ${captured.size} original transition calls; ${large} attachment calls exceed the recorder limit.`);
});
