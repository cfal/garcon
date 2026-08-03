import { describe, expect, it, mock } from 'bun:test';
import { SteerDeliveryError } from '../../lib/domain-error.ts';
import { CommandValidationError } from '../../lib/command-validation-error.ts';
import { logSteerOutcome } from '../steer-commands.ts';

function logger() {
  return {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  };
}

describe('steer outcome logging', () => {
  it('records accepted command correlation without prompt content', () => {
    const outcomeLogger = logger();

    logSteerOutcome(outcomeLogger, {
      chatId: 'chat-1',
      clientRequestId: 'request-1',
      integrationId: 'codex',
      turnId: 'turn-1',
    }, { kind: 'accepted', status: 'accepted' });

    expect(outcomeLogger.info).toHaveBeenCalledWith('steer accepted', {
      chatId: 'chat-1',
      clientRequestId: 'request-1',
      integrationId: 'codex',
      turnId: 'turn-1',
      source: 'inline',
      status: 'accepted',
    });
  });

  it('records core rejections at the command boundary', () => {
    const outcomeLogger = logger();

    logSteerOutcome(outcomeLogger, {
      chatId: 'chat-1',
      clientRequestId: 'request-1',
      integrationId: 'codex',
      turnId: 'turn-1',
    }, {
      kind: 'failed',
      error: new CommandValidationError(
        'STEER_TURN_CHANGED',
        'The active turn changed',
        409,
      ),
    });

    expect(outcomeLogger.warn).toHaveBeenCalledWith('steer rejected', {
      chatId: 'chat-1',
      clientRequestId: 'request-1',
      integrationId: 'codex',
      turnId: 'turn-1',
      source: 'inline',
      errorCode: 'STEER_TURN_CHANGED',
    });
  });

  it('records unknown delivery as an attempted-send error', () => {
    const outcomeLogger = logger();

    logSteerOutcome(outcomeLogger, {
      chatId: 'chat-1',
      clientRequestId: 'request-1',
    }, {
      kind: 'failed',
      error: new SteerDeliveryError(new Error('transport closed'), 'unknown'),
    });

    expect(outcomeLogger.error).toHaveBeenCalledWith('steer failed', {
      chatId: 'chat-1',
      clientRequestId: 'request-1',
      source: 'inline',
      errorCode: 'STEER_OUTCOME_UNKNOWN',
      sendAttempted: true,
    });
  });
});
