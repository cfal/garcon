import { DomainError } from '../lib/domain-error.ts';
import type { CapturedSteerTarget } from './types.ts';

interface ControlInputDeliveryOptions {
  captureTarget(chatId: string): CapturedSteerTarget | null;
  deliverSteer(
    chatId: string,
    content: string,
    transcriptViewId: string,
    target: CapturedSteerTarget,
  ): Promise<void>;
  scheduleRun(
    chatId: string,
    content: string,
    transcriptViewId: string,
    onReserved: (turnId: string) => void,
  ): Promise<void>;
}

export class ControlInputDelivery {
  constructor(private readonly options: ControlInputDeliveryOptions) {}

  async deliver(
    chatId: string,
    content: string,
    transcriptViewId: string,
    emittingRunId: string | null,
    signal: AbortSignal,
    onControlRun: (turnId: string) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const captured = emittingRunId === null ? null : this.options.captureTarget(chatId);
    const target = captured?.identity.turnId === emittingRunId ? captured : null;

    if (target) {
      try {
        await this.options.deliverSteer(chatId, content, transcriptViewId, target);
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (!isDefinitiveNonDelivery(error)) throw error;
        await waitAbortably(target.attempt.waitUntilSettled(), signal);
      }
    }

    signal.throwIfAborted();
    await this.options.scheduleRun(chatId, content, transcriptViewId, onControlRun);
  }
}

function isDefinitiveNonDelivery(error: unknown): boolean {
  if (error instanceof DomainError) {
    return error.code === 'STEER_TURN_UNAVAILABLE'
      || error.code === 'STEER_TURN_CHANGED'
      || error.code === 'STEER_TURN_NOT_STEERABLE'
      || error.code === 'OPERATION_UNSUPPORTED'
      || error.code === 'STEER_NOT_DELIVERED';
  }
  return false;
}

function waitAbortably(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
