import crypto from 'node:crypto';
import { createLogger } from '../../common/log.ts';
import type { ChatExecutionControlOperations } from './chat-execution-control-operations.ts';
import type { StoredChatExecutionControlState } from './control-state.ts';
import type { SteerInputDelivery } from './steer-input-delivery.ts';
import type { CapturedSteerTarget } from './types.ts';

const logger = createLogger('queued-steer');

export interface QueuedSteerDeliveryOptions {
  controls: ChatExecutionControlOperations;
  steerInput: SteerInputDelivery;
  resolveContent(input: { chatId: string; clientRequestId: string; content: string }): Promise<string>;
  canDeliver(chatId: string): boolean;
  requestDrain(chatId: string, context: string): void;
  trackTask(task: Promise<void>): void;
}

// Delivers the steer entries at the head of an unpaused queue into the active turn once the
// turn can take them. With no turn running, the drain dispatches a steer entry as the next
// turn instead. One pass runs per chat at a time, and a request during a pass runs another.
export class QueuedSteerDelivery {
  readonly #passes = new Map<string, { rerun: boolean }>();
  readonly #chatsWithSteers = new Set<string>();
  // A turn that refused a queued steer before recording it, as for a stale transcript view,
  // would refuse it again, and every attempt republishes the queue, so its queued steers
  // wait for the drain instead.
  readonly #refusingTurnIds = new Map<string, string>();

  constructor(private readonly options: QueuedSteerDeliveryOptions) {}

  // Runs a pass for every published control state that holds a queued steer.
  observe(chatId: string, control: StoredChatExecutionControlState): void {
    if (!control.entries.some((entry) => entry.kind === 'steer' && entry.status === 'queued')) {
      this.#chatsWithSteers.delete(chatId);
      this.#refusingTurnIds.delete(chatId);
      return;
    }
    this.#chatsWithSteers.add(chatId);
    this.request(chatId);
  }

  // Runs a pass for a chat with queued steers, as when its active run becomes steerable.
  retry(chatId: string): void {
    if (this.#chatsWithSteers.has(chatId)) this.request(chatId);
  }

  forget(chatId: string): void {
    this.#chatsWithSteers.delete(chatId);
    this.#refusingTurnIds.delete(chatId);
  }

  request(chatId: string): void {
    const running = this.#passes.get(chatId);
    if (running) {
      running.rerun = true;
      return;
    }
    const pass = { rerun: false };
    this.#passes.set(chatId, pass);
    this.options.trackTask(this.#run(chatId, pass));
  }

  async #run(chatId: string, pass: { rerun: boolean }): Promise<void> {
    try {
      do {
        pass.rerun = false;
        await this.#deliverHeads(chatId);
      } while (pass.rerun);
    } finally {
      this.#passes.delete(chatId);
    }
  }

  // A failure ends this attempt without retrying it, but a request made meanwhile still runs.
  async #deliverHeads(chatId: string): Promise<void> {
    try {
      while (await this.#deliverHead(chatId)) { /* The next head may be a steer as well. */ }
    } catch (error) {
      logger.warn('queued steer delivery failed', {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Returns whether the queue changed in a way that makes the head worth reading again.
  async #deliverHead(chatId: string): Promise<boolean> {
    if (!this.options.canDeliver(chatId)) return false;
    const control = await this.options.controls.read(chatId);
    const head = control.entries.find((entry) => entry.status === 'queued');
    // A steer is admitted under its submission's identity; an entry without one, which only
    // the direct queue API creates, is left for the drain.
    if (
      control.pause
      || head?.kind !== 'steer'
      || !head.submission
      || control.entries.some((entry) => entry.status === 'steering')
    ) return false;
    const target = await this.#steerableTarget(chatId);
    if (!target) return false;

    const clientRequestId = crypto.randomUUID();
    const providerContent = await this.options.resolveContent({
      chatId,
      clientRequestId,
      content: head.content,
    });
    // A pause or edit since the read rejects the reservation, and the next read sees it.
    const reservation = await this.options.controls.reservePendingSteer(chatId, {
      entryId: head.id,
      expectedRevision: head.revision,
      expectedReorderRevision: control.reorderRevision,
    }).catch(() => null);
    if (!reservation) return true;
    const { entry } = reservation;

    let admitted = false;
    try {
      await this.options.steerInput.deliver(
        chatId,
        entry.content,
        providerContent,
        {
          clientRequestId,
          clientMessageId: head.submission.clientMessageId,
          transcriptViewId: head.submission.transcriptViewId,
        },
        target,
        async () => { admitted = true; },
      );
    } catch (error) {
      if (!admitted) {
        // Nothing was recorded, so the entry waits for the drain.
        this.#refusingTurnIds.set(chatId, target.identity.turnId);
        await this.options.controls.releaseSteer(chatId, entry.id);
        this.options.requestDrain(chatId, 'queued steer released');
        return false;
      }
      // Its row is in the transcript, so delivering the entry again would duplicate it.
      logger.warn('queued steer was recorded but not confirmed', {
        chatId,
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.options.controls.consumeSteer(chatId, entry.id);
    this.options.requestDrain(chatId, 'queued steer consumed');
    return true;
  }

  // The active turn's steering target, when that turn can take the chat's queued steers now.
  async #steerableTarget(chatId: string): Promise<CapturedSteerTarget | null> {
    const target = await this.options.steerInput.captureTarget(chatId).catch(() => null);
    if (!target?.providerTarget) return null;
    if (this.#refusingTurnIds.get(chatId) === target.identity.turnId) return null;
    return target;
  }
}
