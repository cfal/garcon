import type { ChatMessage } from '../../common/chat-types.js';
import { createLogger } from '../lib/log.js';
import { ChatRunningError } from './errors.js';

const logger = createLogger('chat-idle-reconcile');

const DEFAULT_DEBOUNCE_MS = 5_000;

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
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(options: IdleNativeReconcilerOptions) {
    this.#views = options.views;
    this.#source = options.source;
    this.#ownsExecution = options.ownsExecution;
    this.#onGenerationReset = options.onGenerationReset;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  // Chats can report idle several times per settle, and a new turn can start during the wait, so
  // the timer restarts on each signal and the work re-checks ownership when it fires.
  noteIdle(chatId: string): void {
    const existing = this.#timers.get(chatId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#timers.delete(chatId);
      void this.ensureReconciled(chatId);
    }, this.#debounceMs);
    timer.unref?.();
    this.#timers.set(chatId, timer);
  }

  cancel(chatId: string): void {
    const existing = this.#timers.get(chatId);
    if (!existing) return;
    clearTimeout(existing);
    this.#timers.delete(chatId);
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

  async #reconcile(chatId: string): Promise<void> {
    if (this.#ownsExecution(chatId)) return;
    const before = this.#views.getCursor(chatId);
    // Nothing above the seqs read from the transcript means every client seq already addresses
    // a native position, so there is nothing to rebuild.
    if (before === null || before.lastSeq === this.#views.getNativeHistoryLastSeq(chatId)) return;
    try {
      const messages = await this.#source.loadNativeMessages(chatId);
      await this.#views.reconcileNativeSnapshot(chatId, messages);
    } catch (error) {
      // A turn that started during the load owns the view again; the next idle signal retries.
      if (error instanceof ChatRunningError) return;
      logger.warn(`reconcile failed chat=${chatId}:`, error);
      return;
    }
    const after = this.#views.getCursor(chatId);
    if (!after || (before && before.generationId === after.generationId)) return;
    this.#onGenerationReset(chatId, after.generationId, after.lastSeq);
  }
}
