import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asyncQuestionReplyText } from '../../../common/async-user-questions.js';
import { UserMessage } from '../../../common/chat-types.js';
import { nextRunOrSteerRoute } from '../../../common/run-or-steer.js';
import { DomainError } from '../../../server/common/domain-error.js';
import { QueueExecutionAttempt } from '../../../server/controller/chat-execution/execution-attempt.js';
import { ExecutionOwnership } from '../../../server/controller/chat-execution/execution-ownership.js';
import { SteerInputDelivery } from '../../../server/controller/chat-execution/steer-input-delivery.js';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('a turn ending after durable answer admission cannot authorize a second run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'async-answer-admission-'));
  const store = new TranscriptLedgerStore(directory);
  const transcripts = new TranscriptLedgerService(store);
  const chatId = '1000000000000001';
  const view = transcripts.initializeChat(chatId);
  const attempt = new QueueExecutionAttempt({ turnId: 'synthetic-turn' });
  const ownership = new ExecutionOwnership();
  ownership.installAttempt(chatId, attempt);
  const admitted = Promise.withResolvers<void>();
  const finishTurn = Promise.withResolvers<void>();
  const questionReply = { questionId: 'question', question: 'Which environment?', answer: 'Staging',
    source: { chatId, transcriptViewId: view.viewId, ordinal: 1 } };
  const content = asyncQuestionReplyText(questionReply);
  const delivery = new SteerInputDelivery({
    ownership,
    isShuttingDown: () => false,
    turnRunner: {
      captureSteerTarget: async () => ({ kind: 'steer-target', id: 'synthetic-target',
        executorId: 'local', instanceId: 'synthetic-instance', integrationId: 'test' }),
      steerInput: async () => { throw new Error('Settled turns must not receive input'); },
      runAgentTurn: async () => { throw new Error('Unexpected run'); },
      abortSession: async () => false,
      isChatRunning: () => !attempt.isSettled,
    },
    admitInput: async (id, text, options) => transcripts.appendInputAndCompose({
      chatId: id, viewId: view.viewId, clientMessageId: options.clientMessageId ?? null,
      message: new UserMessage('2026-01-01T00:00:00Z', text, undefined, { questionReply: options.questionReply }),
      attachments: [], steer: true,
    }).inserted,
    discardPreparedInput: (id, messageId) => transcripts.discardPreparedInput(id, messageId),
  });
  try {
    const target = await delivery.captureTarget(chatId, null);
    if (!target) throw new Error('Missing steering target');
    const result = rejectionOf(delivery.deliver(chatId, content, content, {
      clientRequestId: 'synthetic-request', clientMessageId: 'synthetic-message',
      transcriptViewId: view.viewId, questionReply,
    }, target, async () => {
      admitted.resolve();
      await finishTurn.promise;
    }));
    await admitted.promise;
    expect(transcripts.currentRows(chatId)).toMatchObject([{ kind: 'user-input',
      detail: { message: { content, metadata: { questionReply } } } }]);
    attempt.markSettled();
    finishTurn.resolve();
    const error = await result;
    expect(error).toMatchObject({ code: 'STEER_NOT_DELIVERED', outcome: 'not-sent' });
    if (!(error instanceof DomainError)) throw new Error('Missing typed delivery failure');
    expect(nextRunOrSteerRoute('steer', error.status, error.code)).toBeNull();
    expect(transcripts.currentRows(chatId)).toHaveLength(1);
    expect(transcripts.takePreparedInput(chatId, 'synthetic-message')).toBeNull();
  } finally {
    finishTurn.resolve();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
