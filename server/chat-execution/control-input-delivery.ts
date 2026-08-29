import type { CapturedSteerTarget } from './types.ts';
import { ControlSteerDelivery } from './control-steer-delivery.ts';

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
  readonly #steerDelivery: ControlSteerDelivery;

  constructor(private readonly options: ControlInputDeliveryOptions) {
    this.#steerDelivery = new ControlSteerDelivery(options.deliverSteer);
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
    const captured = emittingRunId === null ? null : this.options.captureTarget(chatId);
    const target = captured?.identity.turnId === emittingRunId ? captured : null;

    if (target) {
      const outcome = await this.#steerDelivery.toCapturedTarget(
        chatId,
        content,
        transcriptViewId,
        target,
        signal,
      );
      if (outcome === 'delivered') return;
    }

    signal.throwIfAborted();
    await this.options.scheduleRun(chatId, content, transcriptViewId, onControlRun);
  }
}
