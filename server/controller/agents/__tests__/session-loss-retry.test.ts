import { expect, test } from 'bun:test';
import { AgentCallError } from '@garcon/server-agent-interface';
import { ExecutorSessionLostError } from '../../../common/executor-disconnect.js';
import { retryAfterSessionLoss } from '../session-loss-retry.js';

test('repeats a step only after its executor session was lost, at most three times', async () => {
  const outcomes: unknown[] = [
    new ExecutorSessionLostError('unknown', 'Synthetic loss before the reply'),
    new ExecutorSessionLostError('not-dispatched', 'Synthetic loss before sending'),
    'resolved',
  ];
  let calls = 0;
  const step = async () => {
    const outcome = outcomes[calls++];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  expect(await retryAfterSessionLoss(step)).toBe('resolved');
  expect(calls).toBe(3);

  calls = 0;
  const lost = new ExecutorSessionLostError('unknown', 'Synthetic repeated loss');
  await expect(retryAfterSessionLoss(async () => { calls++; throw lost; })).rejects.toBe(lost);
  expect(calls).toBe(3);
});

test('does not repeat other failures or a cancelled step', async () => {
  let calls = 0;
  const unknown = new AgentCallError('unknown', 'Synthetic unknown outcome on a live session');
  await expect(retryAfterSessionLoss(async () => { calls++; throw unknown; })).rejects.toBe(unknown);
  expect(calls).toBe(1);

  calls = 0;
  const admission = new AbortController();
  const stopped = new Error('Synthetic stop');
  await expect(retryAfterSessionLoss(async () => {
    calls++;
    admission.abort(stopped);
    throw new ExecutorSessionLostError('unknown', 'Synthetic loss after Stop');
  }, admission.signal)).rejects.toBe(stopped);
  expect(calls).toBe(1);
});
