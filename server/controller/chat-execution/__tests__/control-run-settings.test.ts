import { expect, test } from 'bun:test';
import type { PermissionMode } from '@garcon/common/chat-modes';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { ChatExecutionCoordinator } from '../chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.js';

test('a server control turn reads the permission mode after an in-flight settings save commits', async () => {
  const lock = new KeyedPromiseLock();
  const projectChecked = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  let saved: PermissionMode = 'bypassPermissions';
  const dispatched: (PermissionMode | undefined)[] = [];
  const unexpected = (): never => { throw new Error('Unexpected user input operation'); };
  const coordinator = new ChatExecutionCoordinator({
    async runAgentTurn(_chatId, _content, options) { dispatched.push(options?.permissionMode); },
    captureSteerTarget: async () => null, steerInput: unexpected, abortSession: unexpected, isChatRunning: () => false,
  }, {
    admitInput: unexpected, admitQueuedInput: unexpected, hasMatchingInput: unexpected, discardPreparedInput() {},
  }, () => ({ permissionMode: saved }), () => true, new InMemoryChatExecutionControlRepository('instance'), {
    selectionAdmissionLock: lock, canDispatch: () => true, isControlInputViewCurrent: () => true,
    assertChatExecutable: () => {},
    projectAdmission: { async assertAvailable() { projectChecked.resolve(); } }, attachmentAdmission: { assertSupported() {} },
  });
  const saving = lock.runExclusive('chat:chat-id', async () => { await commit.promise; saved = 'default'; });
  const run = coordinator.deliverControlInput('chat-id', 'synthetic control', 'view', null, new AbortController().signal, () => {});
  try {
    await projectChecked.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(dispatched).toEqual([]);
  } finally {
    commit.resolve();
    await saving;
    await run;
    await coordinator.waitForDispatches();
  }
  expect(dispatched).toEqual(['default']);
});
