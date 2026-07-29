import { setTimeout as sleep } from 'node:timers/promises';
import type { ChatMessage } from '../../common/chat-types.js';
import { createLogger } from '../lib/log.js';
import { ChatRunningError } from './errors.js';

const logger = createLogger('chat-idle-reconcile');

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_SETTLE_MS = 250;

interface NativeHistorySource {
  loadNativeMessages(chatId: string): Promise<ChatMessage[]>;
}

interface ReconcilableViews {
  getNativeHistoryLastSeq(chatId: string): number | null;
  getCursor(chatId: string): { generationId: string; lastSeq: number } | null;
  reconcileNativeSnapshot(chatId: string, messages: readonly ChatMessage[]): Promise<void>;
}

export interface IdleNativeReconcilerOptions {
  views: ReconcilableViews;
  source: NativeHistorySource;
  ownsExecution(chatId: string): boolean;
  onGenerationReset(chatId: string, generationId: string, lastSeq: number): void;
  debounceMs?: number;
  settleMs?: number;
}

// Rebuilds a settled chat's view from native history so its sequence numbers address transcript
// positions again. A turn's output reaches the view before the provider persists it, and nothing
// else re-aligns the two once the turn ends, which is what leaves an idle view unable to resolve
// a fork point. Reconciling uses snapshot semantics rather than a replace so a turn whose
// transcript is still flushing keeps its unpersisted tail.
export class IdleNativeReconciler {
  readonly #views: ReconcilableViews;
  readonly #source: NativeHistorySource;
  readonly #ownsExecution: (chatId: string) => boolean;
  readonly #onGenerationReset: (chatId: string, generationId: string, lastSeq: number) => void;
  readonly #debounceMs: number;
  readonly #settleMs: number;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #inFlight = new Map<string, Promise<void>>();
  #stopped = false;

  constructor(options: IdleNativeReconcilerOptions) {
    this.#views = options.views;
    this.#source = options.source;
    this.#ownsExecution = options.ownsExecution;
    this.#onGenerationReset = options.onGenerationReset;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  }

  // Chats can report idle several times per settle, and a new turn can start during the wait, so
  // the timer restarts on each signal and the work re-checks ownership when it fires.
  noteIdle(chatId: string): void {
    if (this.#stopped) return;
    const existing = this.#timers.get(chatId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#timers.delete(chatId);
      void this.ensureReconciled(chatId);
    }, this.#debounceMs);
    timer.unref?.();
    this.#timers.set(chatId, timer);
  }

  // Reconciling reads the provider transcript, so a debounce that fires during shutdown would
  // start work against integrations that are being torn down. Shutdown drops the pending timers
  // and refuses new ones; an unreconciled view costs nothing once the process is going away.
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  // Reconciles now rather than on the debounce, for callers that need the view to address native
  // positions before they read it. Returns once the view is native-backed or known not to be.
  async ensureReconciled(chatId: string): Promise<void> {
    const inFlight = this.#inFlight.get(chatId);
    if (inFlight) return inFlight;
    const run = this.#reconcile(chatId).finally(() => {
      if (this.#inFlight.get(chatId) === run) this.#inFlight.delete(chatId);
    });
    this.#inFlight.set(chatId, run);
    return run;
  }

  // Contains every failure: this runs from a fire-and-forget timer, so anything it lets escape
  // becomes an unhandled rejection instead of a skipped reconcile.
  async #reconcile(chatId: string): Promise<void> {
    try {
      if (this.#stopped || this.#ownsExecution(chatId)) return;
      const before = this.#views.getCursor(chatId);
      // Nothing above the seqs read from the transcript means every client seq already addresses
      // a native position, so there is nothing to rebuild.
      if (before === null || before.lastSeq === this.#views.getNativeHistoryLastSeq(chatId)) return;
      // Providers persist a settled turn after its live events, so a single read can catch the
      // transcript mid-flush and rebuild the view from a rendering that is about to change,
      // surrendering messages the user already saw. Acting only when two spaced reads agree
      // defers to the flush; the next idle signal retries once the transcript stops moving.
      const first = await this.#source.loadNativeMessages(chatId);
      await sleep(this.#settleMs);
      if (this.#stopped) return;
      const messages = await this.#source.loadNativeMessages(chatId);
      if (this.#stopped || !sameRendering(first, messages)) return;
      await this.#views.reconcileNativeSnapshot(chatId, messages);
      const after = this.#views.getCursor(chatId);
      if (this.#stopped || !after || before.generationId === after.generationId) return;
      this.#onGenerationReset(chatId, after.generationId, after.lastSeq);
    } catch (error) {
      // A turn that started during the load owns the view again; the next idle signal retries.
      if (error instanceof ChatRunningError) return;
      logger.warn(`reconcile failed chat=${chatId}:`, error);
    }
  }
}

function sameRendering(a: ChatMessage[], b: ChatMessage[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}
