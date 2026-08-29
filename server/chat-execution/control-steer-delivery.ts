import { DomainError } from '../lib/domain-error.ts';
import type { CapturedSteerTarget } from './types.ts';

export type ControlSteerOutcome = 'delivered' | 'definitive-non-delivery';

export class ControlSteerDelivery {
  constructor(private readonly deliver: (
    chatId: string,
    content: string,
    transcriptViewId: string,
    target: CapturedSteerTarget,
  ) => Promise<void>) {}

  async toCapturedTarget(
    chatId: string,
    content: string,
    transcriptViewId: string,
    target: CapturedSteerTarget,
    signal: AbortSignal,
  ): Promise<ControlSteerOutcome> {
    signal.throwIfAborted();
    try {
      await this.deliver(chatId, content, transcriptViewId, target);
      return 'delivered';
    } catch (error) {
      signal.throwIfAborted();
      if (!isDefinitiveControlNonDelivery(error)) throw error;
      await waitAbortably(target.attempt.waitUntilSettled(), signal);
      return 'definitive-non-delivery';
    }
  }
}

export function isDefinitiveControlNonDelivery(error: unknown): boolean {
  if (!(error instanceof DomainError)) return false;
  return error.code === 'STEER_TURN_UNAVAILABLE'
    || error.code === 'STEER_TURN_CHANGED'
    || error.code === 'STEER_TURN_NOT_STEERABLE'
    || error.code === 'OPERATION_UNSUPPORTED'
    || error.code === 'STEER_NOT_DELIVERED';
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
