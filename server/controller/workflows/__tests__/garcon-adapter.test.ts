import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { AutomationService } from '../../automation/service.js';
import type { ChatExecutionCoordinator } from '../../chat-execution/chat-execution-coordinator.js';
import { emptyStoredChatExecutionControl } from '../../chat-execution/control-state.js';
import { createWorkflowChatPort } from '../adapters/garcon.js';

function fixture() {
  let owner = true;
  const control = emptyStoredChatExecutionControl('synthetic');
  const queue = Object.assign(new EventEmitter(), {
    ownsExecution: mock(() => owner), readChatExecutionControl: mock(async () => control),
  }) satisfies Pick<ChatExecutionCoordinator, 'on' | 'removeListener' | 'ownsExecution' | 'readChatExecutionControl'>;
  const automation = {
    prepare: mock(async () => ({ kind: 'rejected' as const, code: 'synthetic' })),
    waitForTerminal: mock(async () => ({ executionScope: null, kind: 'unavailable' as const, reason: 'Synthetic',
      commandOutcome: null, receivedOutputCoverage: 'unknown' as const })),
    stop: mock(async () => ({ kind: 'stale-target' as const })),
  } satisfies Pick<AutomationService, 'prepare' | 'waitForTerminal' | 'stop'>;
  const port = createWorkflowChatPort(automation, queue, { hasChat: () => true });
  return { port, queue, control, setOwner: (value: boolean) => { owner = value; } };
}

test.each(['processing-invalidated', 'turn-settled', 'chat-idle'])('ownership release uses %s without leaving listeners', async event => {
  const f = fixture(); const abort = new AbortController();
  const waiting = f.port.waitForOwnershipRelease('synthetic', abort.signal);
  f.setOwner(false);
  f.queue.emit(event, 'other');
  expect(f.queue.listenerCount(event)).toBe(1);
  f.queue.emit(event, 'synthetic'); await waiting;
  expect(f.queue.eventNames()).toHaveLength(0);
});

test('ownership observation handles already released and aborted windows', async () => {
  const f = fixture(); const abort = new AbortController();
  f.setOwner(false);
  await f.port.waitForOwnershipRelease('synthetic', abort.signal);
  expect(f.queue.eventNames()).toHaveLength(0);
  f.setOwner(true);
  const pending = f.port.waitForOwnershipRelease('synthetic', abort.signal);
  abort.abort(new Error('Synthetic shutdown'));
  await expect(pending).rejects.toThrow('Synthetic shutdown');
  await expect(f.port.waitForOwnershipRelease('synthetic', abort.signal)).rejects.toThrow('Synthetic shutdown');
  expect(f.queue.eventNames()).toHaveLength(0);
});

test.each(['user', 'control'])('paused %s inputs remain pending even without an execution owner', async lane => {
  const f = fixture(); f.setOwner(false);
  f.control.pause = { id: 'synthetic-pause', kind: 'manual', pausedAt: '2026-01-01T00:00:00.000Z' };
  if (lane === 'user') f.control.entries.push({ id: 'synthetic', content: 'Synthetic input', kind: 'turn',
    status: 'queued', images: [], revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  else f.control.controlEntries.push({ id: 'synthetic', content: 'Synthetic control', transcriptViewId: 'synthetic-view',
    createdAt: '2026-01-01T00:00:00.000Z', receipt: null });
  expect(await f.port.inspect('synthetic', new AbortController().signal)).toEqual({ exists: true, ownsExecution: false, pendingInput: true });
});

test('inspection samples ownership after the asynchronous control read', async () => {
  const f = fixture(); f.setOwner(false);
  f.queue.readChatExecutionControl.mockImplementation(async () => { f.setOwner(true); return f.control; });
  expect(await f.port.inspect('synthetic', new AbortController().signal)).toEqual({ exists: true, ownsExecution: true, pendingInput: false });
});

test('inspection abandons a blocked control read and ignores its late completion', async () => {
  const f = fixture(); const finish = Promise.withResolvers<typeof f.control>(); const abort = new AbortController();
  f.queue.readChatExecutionControl.mockReturnValueOnce(finish.promise);
  const pending = f.port.inspect('synthetic', abort.signal);
  abort.abort(new Error('Synthetic observation deadline'));
  await expect(pending).rejects.toThrow('Synthetic observation deadline');
  finish.resolve(f.control); await Promise.resolve();
  expect(f.queue.ownsExecution).not.toHaveBeenCalled();
});
