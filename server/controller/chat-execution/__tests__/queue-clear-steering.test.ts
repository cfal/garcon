import { expect, test } from 'bun:test';
import type { AgentSteerResult } from '@garcon/server-agent-interface';
import { DomainError } from '../../../common/domain-error.ts';
import { KeyedPromiseLock } from '../../../common/keyed-lock.ts';
import { ChatExecutionControlOperations } from '../chat-execution-control-operations.ts';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.ts';
import { ExecutionOwnership } from '../execution-ownership.ts';
import { QueueExecutionAttempt } from '../execution-attempt.ts';
import { QueuedSteerDelivery } from '../queued-steer-delivery.ts';
import { SteerInputDelivery } from '../steer-input-delivery.ts';
import type { AgentTurnRunnerPort } from '../types.ts';

const chatId = 'chat-1';

function fixture() {
  const locks = new KeyedPromiseLock();
  const controls = new ChatExecutionControlOperations(new InMemoryChatExecutionControlRepository('instance'), {
    runExclusive: (id, operation) => locks.runExclusive(id, operation),
    chatExists: () => true,
    unsettledQueueReceiptKeys: () => new Set(),
    publish() {},
    inputAccepted() {},
  }, { assertAvailable: async () => {} }, { assertSupported() {} });
  const ownership = new ExecutionOwnership();
  ownership.installAttempt(chatId, new QueueExecutionAttempt({ turnId: 'turn-1', clientRequestId: 'request-1' }));
  const admissionStarted = Promise.withResolvers<void>();
  const admission = Promise.withResolvers<boolean>();
  const providerStarted = Promise.withResolvers<void>();
  const providerReply = Promise.withResolvers<AgentSteerResult>();
  const turnRunner = {
    runAgentTurn: async () => {},
    captureSteerTarget: async () => ({
      kind: 'steer-target' as const, id: 'target', executorId: 'local', instanceId: 'runtime', integrationId: 'test',
    }),
    steerInput: async (_id, _input, _options, _target, prepareDelivery) => {
      await prepareDelivery();
      providerStarted.resolve();
      return providerReply.promise;
    },
    abortSession: async () => false,
    isChatRunning: () => true,
  } satisfies AgentTurnRunnerPort;
  const steerInput = new SteerInputDelivery({
    turnRunner, ownership, isShuttingDown: () => false,
    admitInput: async () => {
      admissionStarted.resolve();
      return admission.promise;
    },
    discardPreparedInput() {},
  });
  const tasks: Promise<void>[] = [];
  const delivery = new QueuedSteerDelivery({
    controls, steerInput, resolveContent: async ({ content }) => content,
    canDeliver: () => true, requestDrain() {}, trackTask: task => { tasks.push(task); },
  });
  return { controls, delivery, tasks, admissionStarted, admission, providerStarted, providerReply };
}

test.each(['accepted', 'refused-after-admission', 'refused-before-admission'] as const)(
  'clear cannot retire a reserved steer during %s delivery', async outcome => {
    const f = fixture();
    await f.controls.create(chatId, { content: 'future turn', images: [] });
    await f.controls.createSteer(chatId, 'guidance', { key: 'steer', entryId: 'steer' }, {
      clientMessageId: 'input', transcriptViewId: 'view',
    });
    f.delivery.request(chatId);
    try {
      await f.admissionStarted.promise;
      if (outcome !== 'refused-before-admission') {
        f.admission.resolve(true);
        await f.providerStarted.promise;
      }
      await f.controls.pause(chatId);
      const before = await f.controls.read(chatId);
      expect(before.entries[0]).toMatchObject({ id: 'steer', status: 'steering' });
      expect(before.recentlyDispatched).toEqual([]);
      await expect(f.controls.clear(chatId)).rejects.toMatchObject({ code: 'QUEUE_ENTRY_IN_FLIGHT' });
      expect(await f.controls.read(chatId)).toEqual(before);
    } finally {
      if (outcome === 'refused-before-admission') {
        f.admission.reject(new DomainError('STALE_TRANSCRIPT_VIEW', 'View replaced', 409));
      } else {
        f.providerReply.resolve(outcome === 'accepted'
          ? { kind: 'accepted' }
          : { kind: 'rejected', reason: 'turn-not-steerable', message: 'Turn cannot be steered' });
      }
      await Promise.all(f.tasks);
    }
    const settled = await f.controls.read(chatId);
    expect(settled.entries.map(entry => entry.content)).toEqual(outcome === 'refused-before-admission'
      ? ['guidance', 'future turn'] : ['future turn']);
    expect(settled.recentlyDispatched.map(receipt => receipt.entryId)).toEqual(
      outcome === 'refused-before-admission' ? [] : ['steer'],
    );
    const cleared = await f.controls.clear(chatId);
    expect(cleared.entries).toEqual([]);
    expect(cleared.pause).toBeNull();
    expect(cleared.recentlyDispatched).toEqual(settled.recentlyDispatched);
  },
);
