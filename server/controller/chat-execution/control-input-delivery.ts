import { waitAbortably } from '../../common/abortable-wait.ts';
import { DomainError } from '../../common/domain-error.ts';
import type { CapturedControlOffer, CapturedSteerTarget } from './types.ts';
import type { SteerInputDelivery } from './steer-input-delivery.ts';

interface ControlInputDeliveryOptions {
  captureTarget(chatId: string): Promise<CapturedSteerTarget | null>;
  deliverSteer: SteerInputDelivery['deliverControl'];
  scheduleRun(
    chatId: string,
    content: string,
    transcriptViewId: string,
    onReserved: (turnId: string) => void,
  ): Promise<void>;
}

export class ControlInputDelivery {
  constructor(private readonly options: ControlInputDeliveryOptions) {}

  // Offers without waiting under the caller's lock. Only a definite non-delivery
  // permits fallback after the captured turn settles.
  async offerToCapturedTarget(
    chatId: string, content: string, transcriptViewId: string, target: CapturedSteerTarget, signal: AbortSignal,
  ): Promise<CapturedControlOffer> {
    signal.throwIfAborted();
    if (target.providerTarget) {
      try {
        await this.options.deliverSteer(chatId, content, transcriptViewId, target);
        return { kind: 'delivered' };
      } catch (error) {
        signal.throwIfAborted();
        if (!isDefinitiveControlNonDelivery(error)) throw error;
      }
    }
    return { kind: 'after-turn', turnSettled: target.attempt.waitUntilSettled() };
  }

  async deliver(
    chatId: string,
    content: string,
    transcriptViewId: string,
    emittingRunId: string | null,
    signal: AbortSignal,
    onControlRun: (turnId: string) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const captured = emittingRunId === null ? null : await this.options.captureTarget(chatId);
    const target = captured?.identity.turnId === emittingRunId ? captured : null;

    if (target) {
      const offer = await this.offerToCapturedTarget(chatId, content, transcriptViewId, target, signal);
      if (offer.kind === 'delivered') return;
      await waitAbortably(offer.turnSettled, signal);
    }

    signal.throwIfAborted();
    await this.options.scheduleRun(chatId, content, transcriptViewId, onControlRun);
  }
}

function isDefinitiveControlNonDelivery(error: unknown): boolean {
  if (!(error instanceof DomainError)) return false;
  return error.code === 'STEER_TURN_UNAVAILABLE'
    || error.code === 'STEER_TURN_CHANGED'
    || error.code === 'STEER_TURN_NOT_STEERABLE'
    || error.code === 'OPERATION_UNSUPPORTED'
    || error.code === 'EXECUTOR_UNAVAILABLE'
    || error.code === 'STEER_NOT_DELIVERED';
}
