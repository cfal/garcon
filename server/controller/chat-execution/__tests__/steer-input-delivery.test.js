import { describe, expect, it, mock } from 'bun:test';
import { ExecutionOwnership } from '../execution-ownership.ts';
import { QueueExecutionAttempt } from '../execution-attempt.ts';
import { SteerInputDelivery } from '../steer-input-delivery.ts';

const CHAT_ID = 'chat-1';
const OPTIONS = {
  clientRequestId: 'request-steer',
  clientMessageId: 'message-steer',
  transcriptViewId: 'view-1',
};
const QUESTION_OPTIONS = { ...OPTIONS, questionReply: {
  questionId: 'question', question: 'Which environment?', answer: 'Staging',
  source: { chatId: CHAT_ID, transcriptViewId: OPTIONS.transcriptViewId, ordinal: 1 },
} };

function scaffold({ providerTarget = {} } = {}) {
  const ownership = new ExecutionOwnership();
  ownership.installAttempt(CHAT_ID, new QueueExecutionAttempt({ turnId: 'turn-1' }));
  const turnRunner = {
    captureSteerTarget: mock(async () => providerTarget),
    steerInput: mock(async (_chatId, _input, _options, _target, prepareDelivery) => {
      await prepareDelivery();
      return { kind: 'accepted' };
    }),
  };
  const admitInput = mock(async () => true);
  const discardPreparedInput = mock(() => undefined);
  const delivery = new SteerInputDelivery({
    turnRunner,
    ownership,
    isShuttingDown: () => false,
    admitInput,
    discardPreparedInput,
  });
  return { delivery, turnRunner, admitInput, discardPreparedInput };
}

describe('SteerInputDelivery', () => {
  it('refuses a turn that cannot take steering yet before admitting the input', async () => {
    const { delivery, turnRunner, admitInput } = scaffold({ providerTarget: null });
    const target = await delivery.captureTarget(CHAT_ID);
    const afterPendingRegistered = mock(async () => undefined);

    expect(target?.providerTarget).toBeNull();
    await expect(delivery.deliver(
      CHAT_ID, 'guidance', 'guidance', QUESTION_OPTIONS, target, afterPendingRegistered,
    )).rejects.toMatchObject({ code: 'STEER_TURN_UNAVAILABLE', status: 409 });
    expect(admitInput).not.toHaveBeenCalled();
    expect(afterPendingRegistered).not.toHaveBeenCalled();
    expect(turnRunner.steerInput).not.toHaveBeenCalled();
  });

  it('admits the input before delivering it to a steerable turn', async () => {
    const { delivery, turnRunner, admitInput, discardPreparedInput } = scaffold();
    const target = await delivery.captureTarget(CHAT_ID);
    const afterPendingRegistered = mock(async () => undefined);

    await expect(delivery.deliver(
      CHAT_ID, 'guidance', 'guidance with context', OPTIONS, target, afterPendingRegistered,
    )).resolves.toEqual({ turnId: 'turn-1', duplicate: false });
    expect(admitInput).toHaveBeenCalledWith(CHAT_ID, 'guidance', expect.objectContaining({
      clientMessageId: 'message-steer',
      turnId: 'turn-1',
      commandType: 'steer',
    }));
    expect(afterPendingRegistered).toHaveBeenCalledWith('turn-1');
    expect(turnRunner.steerInput.mock.calls[0][1]).toBe('guidance with context');
    expect(discardPreparedInput).toHaveBeenCalledWith(CHAT_ID, 'message-steer');
  });

  it.each(['no-active-turn', 'turn-changed'])('does not authorize resubmitting an admitted question after %s', async reason => {
    const { delivery, turnRunner, admitInput } = scaffold();
    const target = await delivery.captureTarget(CHAT_ID);
    turnRunner.steerInput.mockImplementation(async () => ({ kind: 'rejected', reason }));
    await expect(delivery.deliver(
      CHAT_ID, 'answer', 'answer', QUESTION_OPTIONS, target, async () => undefined,
    )).rejects.toMatchObject({ code: 'STEER_NOT_DELIVERED', outcome: 'not-sent' });
    expect(admitInput).toHaveBeenCalledTimes(1);
  });

  it('does not authorize another route when the captured turn settles after question admission', async () => {
    const { delivery, turnRunner, admitInput, discardPreparedInput } = scaffold();
    const target = await delivery.captureTarget(CHAT_ID);
    await expect(delivery.deliver(
      CHAT_ID, 'answer', 'answer', QUESTION_OPTIONS, target,
      async () => target.attempt.markSettled(),
    )).rejects.toMatchObject({ code: 'STEER_NOT_DELIVERED', outcome: 'not-sent' });
    expect(admitInput).toHaveBeenCalledTimes(1);
    expect(turnRunner.steerInput).not.toHaveBeenCalled();
    expect(discardPreparedInput).toHaveBeenCalledWith(CHAT_ID, OPTIONS.clientMessageId);
  });
});
