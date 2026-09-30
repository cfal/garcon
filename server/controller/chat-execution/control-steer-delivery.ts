import { waitAbortably } from '../../common/abortable-wait.ts';
import { DomainError } from '../../common/domain-error.ts';
import type { CapturedSteerTarget } from './types.ts';

export type ControlSteerOutcome = 'delivered' | 'definitive-non-delivery';

export class ControlSteerDelivery {
  constructor(private readonly deliver: (
    chatId: string,
    content: string,
    transcriptViewId: string,
    target: CapturedSteerTarget,
  ) => Promise<void>) {}

  // Steers into the captured turn without waiting for it. After a definitive
  // non-delivery, input may fall back only once that exact turn settles.
  async offerToCapturedTarget(
    chatId: string,
    content: string,
    transcriptViewId: string,
    target: CapturedSteerTarget,
    signal: AbortSignal,
  ): Promise<ControlSteerOutcome> {
    signal.throwIfAborted();
    if (!target.providerTarget) return 'definitive-non-delivery';
    try {
      await this.deliver(chatId, content, transcriptViewId, target);
      return 'delivered';
    } catch (error) {
      signal.throwIfAborted();
      if (!isDefinitiveControlNonDelivery(error)) throw error;
      return 'definitive-non-delivery';
    }
  }

  async toCapturedTarget(
    chatId: string,
    content: string,
    transcriptViewId: string,
    target: CapturedSteerTarget,
    signal: AbortSignal,
  ): Promise<ControlSteerOutcome> {
    const outcome = await this.offerToCapturedTarget(chatId, content, transcriptViewId, target, signal);
    if (outcome === 'definitive-non-delivery') await waitAbortably(target.attempt.waitUntilSettled(), signal);
    return outcome;
  }
}

export function isDefinitiveControlNonDelivery(error: unknown): boolean {
  if (!(error instanceof DomainError)) return false;
  return error.code === 'STEER_TURN_UNAVAILABLE'
    || error.code === 'STEER_TURN_CHANGED'
    || error.code === 'STEER_TURN_NOT_STEERABLE'
    || error.code === 'OPERATION_UNSUPPORTED'
    || error.code === 'EXECUTOR_UNAVAILABLE'
    || error.code === 'STEER_NOT_DELIVERED';
}
