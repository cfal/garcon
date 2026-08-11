import { setTimeout as sleep } from 'node:timers/promises';
import type { ChatMessage } from '../../common/chat-types.js';
import type {
  ChatTranscriptSnapshot,
  NativeSnapshotReconciliation,
} from './chat-view-store.js';
import { createLogger } from '../lib/log.js';
import { ChatRunningError } from './errors.js';

const logger = createLogger('chat-idle-reconcile');

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_SETTLE_MS = 250;

interface NativeHistorySource {
  loadNativeSnapshot(chatId: string): Promise<NativeSnapshotReconciliation>;
  loadFullSnapshot(chatId: string): Promise<ChatTranscriptSnapshot>;
}

interface ReconcilableViews {
  getCursor(chatId: string): { generationId: string; lastSeq: number } | null;
  reconcileNativeSnapshot(chatId: string, input: NativeSnapshotReconciliation): Promise<void>;
  reconcileFullSnapshot(chatId: string, input: ChatTranscriptSnapshot): Promise<void>;
}

export interface IdleNativeReconcilerOptions {
  views: ReconcilableViews;
  source: NativeHistorySource;
  ownsExecution(chatId: string): boolean;
  onGenerationReset(
    chatId: string,
    previousGenerationId: string,
    generationId: string,
    lastSeq: number,
  ): void;
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
  readonly #onGenerationReset: IdleNativeReconcilerOptions['onGenerationReset'];
  readonly #debounceMs: number;
  readonly #settleMs: number;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #historyChangeVersions = new Map<string, number>();
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

  noteHistoryChanged(chatId: string): void {
    const version = (this.#historyChangeVersions.get(chatId) ?? 0) + 1;
    this.#historyChangeVersions.set(chatId, version);
    this.noteIdle(chatId);
  }

  // Reconciling reads the provider transcript, so a debounce that fires during shutdown would
  // start work against integrations that are being torn down. Shutdown drops the pending timers
  // and refuses new ones; an unreconciled view costs nothing once the process is going away.
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#historyChangeVersions.clear();
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

  async ensureHistoryChangeReconciled(chatId: string): Promise<void> {
    if (!this.#historyChangeVersions.has(chatId)) return;
    await this.ensureReconciled(chatId);
  }

  // Contains every failure: this runs from a fire-and-forget timer, so anything it lets escape
  // becomes an unhandled rejection instead of a skipped reconcile.
  async #reconcile(chatId: string): Promise<void> {
    try {
      if (this.#stopped || this.#ownsExecution(chatId)) return;
      const before = this.#views.getCursor(chatId);
      const historyChangeVersion = this.#historyChangeVersions.get(chatId);
      if (before === null) {
        this.#clearHistoryChange(chatId, historyChangeVersion);
        return;
      }
      // Providers persist a settled turn after its live events, so a single read can catch the
      // transcript mid-flush and rebuild the view from a rendering that is about to change,
      // surrendering messages the user already saw. Acting only when two spaced reads agree
      // defers to the flush; the next idle signal retries once the transcript stops moving.
      const first = historyChangeVersion === undefined
        ? await this.#source.loadNativeSnapshot(chatId)
        : await this.#source.loadFullSnapshot(chatId);
      await sleep(this.#settleMs);
      if (this.#stopped) return;
      if (historyChangeVersion === undefined) {
        const snapshot = await this.#source.loadNativeSnapshot(chatId);
        if (this.#stopped || !sameSnapshot(first, snapshot)) return;
        await this.#views.reconcileNativeSnapshot(chatId, snapshot);
      } else {
        const snapshot = await this.#source.loadFullSnapshot(chatId);
        if (this.#stopped || !sameSnapshot(first, snapshot)) return;
        await this.#views.reconcileFullSnapshot(chatId, snapshot);
        this.#clearHistoryChange(chatId, historyChangeVersion);
      }
      const after = this.#views.getCursor(chatId);
      if (this.#stopped || !after || before.generationId === after.generationId) return;
      this.#onGenerationReset(chatId, before.generationId, after.generationId, after.lastSeq);
    } catch (error) {
      // A turn that started during the load owns the view again; the next idle signal retries.
      if (error instanceof ChatRunningError) return;
      logger.warn(`reconcile failed chat=${chatId}:`, error);
    }
  }

  #clearHistoryChange(chatId: string, expectedVersion: number | undefined): void {
    if (
      expectedVersion !== undefined
      && this.#historyChangeVersions.get(chatId) === expectedVersion
    ) {
      this.#historyChangeVersions.delete(chatId);
    }
  }
}

function sameSnapshot(
  a: NativeSnapshotReconciliation | ChatTranscriptSnapshot,
  b: NativeSnapshotReconciliation | ChatTranscriptSnapshot,
): boolean {
  return a.compositeRevision === b.compositeRevision
    && a.nativePrefixDigest === b.nativePrefixDigest
    && a.messages.length === b.messages.length
    && JSON.stringify(a.messages) === JSON.stringify(b.messages);
}
