import { expect, mock, test } from 'bun:test';
import { DomainError } from '../../../common/domain-error.js';
import { ChatExecutionControlOperations } from '../chat-execution-control-operations.js';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.js';
import { AcceptedInputHandler } from '../accepted-input-handler.js';
import { ExecutionOwnership } from '../execution-ownership.js';
import { QueueExecutionAttempt } from '../execution-attempt.js';
import { SteerInputDelivery } from '../steer-input-delivery.js';
import { QueueDrainer } from '../queue-drainer.js';

test('draining rejects a preamble input without a receipt but preserves an already-committed receipt', async () => {
  const controls = new ChatExecutionControlOperations(new InMemoryChatExecutionControlRepository('instance'), {
    runExclusive: (_chatId, operation) => operation(), chatExists: () => true,
    unsettledQueueReceiptKeys: () => new Set(), publish() {}, inputAccepted() {},
  }, { assertAvailable: async () => {} }, { assertSupported() {} });
  const chatId = 'chat-1';
  const discarded = await controls.create(chatId, { content: '/blocked', images: [] });
  const committed = await controls.create(chatId, { content: 'Already committed', images: [] });
  const unexpected = (): never => { throw new Error('Unexpected provider dispatch'); };
  const registerQueued = mock((_id: string, content: string) => {
    if (content === '/blocked') throw new DomainError('PREAMBLE_SLASH_COMMAND_BLOCKED', 'Synthetic preamble refusal', 422);
    return false;
  });
  const publishTurnFailed = mock(() => {});
  const runAgentTurn = mock(unexpected);
  const drainer = new QueueDrainer({
    controls, ownership: new ExecutionOwnership(),
    getDrainOptions: () => ({}), runSelectionAdmissionExclusive: (_id, operation) => operation(),
    projectAdmission: { assertAvailable: async () => {} }, attachmentAdmission: { assertSupported() {} },
    turnRunner: {
      runAgentTurn, isChatRunning: () => false, captureSteerTarget: unexpected,
      steerInput: unexpected, abortSession: unexpected,
    },
    callbacks: {
      isShuttingDown: () => false, registerQueued, publishTurnFailed, publishIdle() {}, publishTurnStarted() {},
      appendControlReceipt: unexpected, isControlInputViewCurrent: unexpected,
      discardPreparedInput: unexpected, publishProjectUnavailable: unexpected, retireAttempt: unexpected,
    },
  });

  await drainer.run(chatId);

  const control = await controls.read(chatId);
  expect(control.entries).toEqual([]);
  expect(control.recentlyDispatched.map(receipt => receipt.entryId)).toEqual([committed.entryId]);
  expect(control.recentlyDispatched.some(receipt => receipt.entryId === discarded.entryId)).toBe(false);
  expect(registerQueued.mock.calls.map(([, content]) => content)).toEqual(['/blocked', 'Already committed']);
  expect(publishTurnFailed).toHaveBeenCalledTimes(1);
  expect(runAgentTurn).not.toHaveBeenCalled();
});

test('discarding a dequeue preserves earlier dispatch receipts without adding one for the discard', async () => {
  const controls = new ChatExecutionControlOperations(new InMemoryChatExecutionControlRepository('instance'), {
    runExclusive: (_chatId, operation) => operation(),
    chatExists: () => true,
    unsettledQueueReceiptKeys: () => new Set(),
    publish() {},
    inputAccepted() {},
  }, { assertAvailable: async () => {} }, { assertSupported() {} });
  const chatId = 'chat-1';
  const first = await controls.create(chatId, { content: 'first input', images: [] });
  await controls.create(chatId, { content: 'second input', images: [] });
  await controls.dequeueNextTurn(chatId, () => 'inserted');
  const before = (await controls.read(chatId)).recentlyDispatched;
  expect(before.map(receipt => receipt.entryId)).toEqual([first.entryId]);

  await controls.dequeueNextTurn(chatId, () => 'discarded');
  const after = await controls.read(chatId);
  expect(after.entries).toEqual([]);
  expect(after.recentlyDispatched).toEqual(before);
});

test('a manually steered input can commit before rejection and later leave the queue without a receipt', async () => {
  const chatId = 'chat-1';
  const controls = new ChatExecutionControlOperations(new InMemoryChatExecutionControlRepository('instance'), {
    runExclusive: (_chatId, operation) => operation(), chatExists: () => true,
    unsettledQueueReceiptKeys: () => new Set(), publish() {}, inputAccepted() {},
  }, { assertAvailable: async () => {} }, { assertSupported() {} });
  const ownership = new ExecutionOwnership();
  ownership.installAttempt(chatId, new QueueExecutionAttempt({ turnId: 'turn', clientRequestId: 'request' }));
  const committed: string[] = [];
  const unexpected = (): never => { throw new Error('Unexpected manual steer dependency'); };
  const delivery = new SteerInputDelivery({
    ownership, isShuttingDown: () => false, discardPreparedInput() {},
    admitInput: async (_id, content) => { committed.push(content); return true; },
    turnRunner: {
      runAgentTurn: unexpected, abortSession: unexpected, isChatRunning: () => true,
      captureSteerTarget: async () => ({
        kind: 'steer-target', id: 'target', executorId: 'local', instanceId: 'runtime', integrationId: 'test',
      }),
      steerInput: async (_id, _content, _options, _target, prepare) => {
        await prepare();
        return { kind: 'rejected', reason: 'turn-not-steerable', message: 'Synthetic refusal' };
      },
    },
  });
  const handler = new AcceptedInputHandler({
    controls, projectAdmission: { assertAvailable: async () => {} },
    coordinator: {
      steer: (...args) => delivery.deliver(...args), requestDrain() {},
      reserveDirect: unexpected, checkpoint: unexpected, hasMatchingInput: unexpected,
      admitInput: unexpected, discardPreparedInput: unexpected, releaseDirect: unexpected,
      runDirect: unexpected, trackDispatch: unexpected,
    },
  });
  await controls.createSteer(chatId, 'Synthetic guidance', { key: 'queued', entryId: 'entry' }, {
    clientMessageId: 'input', transcriptViewId: 'view',
  });
  await controls.pause(chatId);
  const target = await delivery.captureTarget(chatId, null);
  if (!target) throw new Error('Expected active steering target');
  await expect(handler.steerQueueEntry({
    command: { key: 'manual-steer', chatId, entryId: 'entry', clientRequestId: 'manual-request' },
    content: 'Synthetic guidance', providerContent: 'Synthetic guidance', clientMessageId: 'input',
    transcriptViewId: 'view', target, expectedRevision: 1, expectedReorderRevision: 0,
    settlement: {
      markScheduled: async () => {}, settleSteerFailure: async () => {},
      markPreScheduleFailure: unexpected, settleQueueMutation: unexpected,
      settleQueueMutationFailure: unexpected, settleSteerSuccess: unexpected,
      settleOperationFailure: unexpected, settleDuplicateInput: unexpected,
    },
  })).rejects.toMatchObject({ deliveryOutcome: 'not-sent' });
  expect(committed).toEqual(['Synthetic guidance']);
  const released = await controls.read(chatId);
  expect(released.entries[0]).toMatchObject({ id: 'entry', status: 'queued' });
  expect(released.recentlyDispatched).toEqual([]);
  const cleared = await controls.clear(chatId);
  expect(cleared.entries).toEqual([]);
  expect(cleared.recentlyDispatched).toEqual([]);
});
