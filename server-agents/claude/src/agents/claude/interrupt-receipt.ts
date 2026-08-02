import type { AgentLogger } from '@garcon/server-agent-interface';
import type { ClaudeActiveTurn } from './active-turn.js';

export interface ClaudeInterruptSession {
  readonly id: string;
  readonly chatId: string;
  readonly activeTurn: ClaudeActiveTurn | null;
  readonly process: { readonly pid?: number } | null;
}

export interface ClaudeInterruptReceiptHandlers {
  readonly logger: AgentLogger;
  readonly finish: () => void;
  readonly clearAbortTimer: () => void;
  readonly armCompletionFallback: () => void;
  readonly flushDeferredIdle: () => void;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function handleClaudeInterruptReceipt(
  session: ClaudeInterruptSession,
  activeTurn: ClaudeActiveTurn,
  value: unknown,
  handlers: ClaudeInterruptReceiptHandlers,
): boolean {
  const turnIsCurrent = session.activeTurn === activeTurn;
  const receipt = record(value);
  const cancelled = stringArray(receipt.cancelled);
  const stillQueued = stringArray(receipt.still_queued);
  const steeringReceipt = activeTurn.steering.observeInterruptReceipt({
    cancelled,
    stillQueued,
  });
  if (steeringReceipt.cancelledCount > 0) handlers.flushDeferredIdle();
  const inputUuid = activeTurn.protocol.inputUuid;
  const details = {
    chatId: session.chatId,
    turnId: activeTurn.eventMetadata.turnId ?? null,
    sessionId: session.id.slice(0, 8),
    processId: session.process?.pid ?? null,
    inputId: inputUuid.slice(0, 8),
    cancelledCount: cancelled.length,
    stillQueuedCount: stillQueued.length,
    steeringCancelledCount: steeringReceipt.cancelledCount,
    steeringStillQueuedCount: steeringReceipt.stillQueuedCount,
  };

  if (!activeTurn.protocol.inputStarted && cancelled.includes(inputUuid)) {
    handlers.logger.info('Claude CLI confirmed queued input cancellation', details);
    if (turnIsCurrent) handlers.finish();
    return true;
  }
  if (!activeTurn.protocol.inputStarted && !stillQueued.includes(inputUuid)) {
    handlers.logger.warn(
      'Claude CLI interrupt did not confirm queued input cancellation',
      details,
    );
    return false;
  }
  if (stillQueued.includes(inputUuid)) {
    if (turnIsCurrent) {
      handlers.clearAbortTimer();
      activeTurn.protocol.markAbortRejected();
    }
    handlers.logger.warn('Claude CLI interrupt left the submitted input queued', details);
    return false;
  }
  if (steeringReceipt.stillQueuedCount > 0) {
    handlers.logger.warn('Claude CLI interrupt left steering input queued', details);
    if (turnIsCurrent) {
      handlers.clearAbortTimer();
      handlers.armCompletionFallback();
    }
    return true;
  }
  handlers.logger.debug('Claude CLI acknowledged interrupt', details);
  if (turnIsCurrent && activeTurn.protocol.inputStarted) {
    handlers.armCompletionFallback();
  }
  return true;
}
