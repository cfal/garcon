import { expect, test } from 'bun:test';
import { createWorkflowRunner } from '../automation-runner.js';

const key = { serverInstanceId: 'test', chatId: 'reserved', turnId: 'turn', clientRequestId: 'request' };
for (const [started, published, expected] of [
  [{ kind: 'not-started', code: 'API_PROVIDER_CONFIGURATION_CHANGED', inputPublished: false }, false, 'failed'],
  [{ kind: 'not-started', code: 'EXECUTOR_UNAVAILABLE', inputPublished: true }, true, 'unknown'],
  [{ kind: 'unknown', reason: 'Unconfirmed admission' }, false, 'unknown'],
  [{ kind: 'published' }, true, 'unknown'],
] as const) {
  test(`workflow chat publication: ${JSON.stringify(started)}`, async () => {
    const events: string[] = [];
    const runner = createWorkflowRunner({
      async prepare() {
        return { kind: 'prepared', turn: { key,
          async start() { events.push('start'); return started; },
          async cancel() { throw new Error('Unexpected cancellation'); },
          release() { events.push('released'); },
        } };
      },
      async waitForTerminal() {
        events.push('wait');
        return { kind: 'unavailable', reason: 'Unconfirmed terminal' };
      },
      async stop() { throw new Error('Unexpected stop'); },
    }, async () => { throw new Error('Unexpected attachment'); });
    const result = await runner.run({ kind: 'command', runId: 'run', stepId: 'step', instanceId: 'instance',
      attemptId: 'request', attemptNumber: 1, location: { executorId: 'local', projectPath: '/project' }, command: 'true' }, {
      signal: new AbortController().signal,
      attachChat(chatId, turnId) { expect([chatId, turnId]).toEqual([key.chatId, key.turnId]); events.push('reserve'); },
      confirmChat() { events.push('confirmed'); },
      emit() { throw new Error('Unexpected agent signal'); },
    });
    expect(result.kind).toBe(expected);
    expect(events).toEqual(['reserve', 'start', ...(published ? ['confirmed'] : []),
      ...(started.kind === 'published' ? ['wait'] : []), 'released']);
  });
}
