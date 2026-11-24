import type { ChatRunOutcome } from '../../../common/chat-activity.js';

interface ActivityOutcome {
  readonly viewId: string;
  readonly outcome: ChatRunOutcome | null;
  readonly live?: boolean;
}

interface ActivityRun {
  readonly viewId: string | null;
  readonly runId: string;
  readonly status: 'started' | 'terminal' | 'retired';
}

export interface ActivityOutcomeAttempt {
  readonly chatId: string;
  readonly state: ActivityOutcome;
  readonly runId?: string;
}

// Keeps process-only results independent of preview validation and fences delayed settlement.
// A failure is fenced by the state observed when it was reported, so input accepted while
// its run was still executing does not discard that run's own result.
export class ChatActivityOutcomes {
  readonly #byChat = new Map<string, ActivityOutcome>();
  readonly #runs = new Map<string, ActivityRun>();

  constructor(private readonly currentView: (chatId: string) => string | null) {}

  get(chatId: string): ChatRunOutcome | null {
    // View replacement invalidates the cache synchronously; list reads never reopen storage.
    return this.#byChat.get(chatId)?.outcome ?? null;
  }

  clear(chatId: string, runId?: string): void {
    const viewId = this.currentView(chatId);
    if (viewId) this.#byChat.set(chatId, { viewId, outcome: null, live: true });
    else this.#byChat.delete(chatId);
    if (runId) this.begin(chatId, runId);
  }

  begin(chatId: string, runId: string): void {
    const viewId = this.currentView(chatId);
    const run = this.#runs.get(chatId);
    if (run?.runId !== runId) {
      this.#runs.set(chatId, { viewId, runId, status: 'started' });
    }
    if (!viewId) {
      this.#byChat.delete(chatId);
      return;
    }
    const previous = this.#byChat.get(chatId);
    this.#byChat.set(chatId, {
      viewId,
      outcome: previous?.viewId === viewId ? previous.outcome : null,
      live: true,
    });
  }

  captureFailure(chatId: string, runId?: string): ActivityOutcomeAttempt | null {
    const attempt = this.#capture(chatId, runId);
    return attempt && this.#canFail(attempt) ? attempt : null;
  }

  captureTerminal(chatId: string, viewId: string, runId: string): ActivityOutcomeAttempt | null {
    const attempt = this.#capture(chatId, runId);
    if (!attempt || attempt.state.viewId !== viewId) return null;
    const run = this.#runs.get(chatId);
    if (run && (run.runId !== runId || run.status === 'retired')) return null;
    if (run && run.viewId !== null && run.viewId !== viewId) return null;
    // Terminal authority survives input acceptance while display publication waits its turn.
    this.#runs.set(chatId, { viewId, runId, status: 'terminal' });
    const display = { ...attempt.state, live: true };
    this.#byChat.set(chatId, display);
    return { ...attempt, state: display };
  }

  captureRepair(chatId: string): ActivityOutcomeAttempt | null {
    return this.#byChat.get(chatId)?.live ? null : this.#capture(chatId);
  }

  invalidateView(chatId: string): void {
    this.#byChat.delete(chatId);
    const run = this.#runs.get(chatId);
    if (run) this.#runs.set(chatId, { ...run, status: 'retired' });
  }

  delete(chatId: string): void {
    this.#byChat.delete(chatId);
    this.#runs.delete(chatId);
  }

  #capture(chatId: string, runId?: string): ActivityOutcomeAttempt | null {
    const viewId = this.currentView(chatId);
    if (!viewId) return null;
    let current = this.#byChat.get(chatId);
    if (current?.viewId !== viewId) {
      current = { viewId, outcome: null };
      this.#byChat.set(chatId, current);
    }
    return { chatId, state: current, runId };
  }

  fail(attempt: ActivityOutcomeAttempt | null): boolean {
    if (!attempt || !this.#isCurrent(attempt) || !this.#canFail(attempt)) return false;
    this.#byChat.set(attempt.chatId, { viewId: attempt.state.viewId, outcome: 'failed', live: true });
    return true;
  }

  #canFail(attempt: ActivityOutcomeAttempt): boolean {
    const run = this.#runs.get(attempt.chatId);
    if (!attempt.runId || !run) return true;
    return run.runId === attempt.runId && run.status === 'started'
      && (run.viewId === null || run.viewId === attempt.state.viewId);
  }

  #isCurrent(attempt: ActivityOutcomeAttempt): boolean {
    return this.#byChat.get(attempt.chatId) === attempt.state
      && this.currentView(attempt.chatId) === attempt.state.viewId;
  }

  restore(attempt: ActivityOutcomeAttempt, outcome: ChatRunOutcome | null): boolean {
    if (attempt.state.live || !this.#isCurrent(attempt)) return false;
    this.#byChat.set(attempt.chatId, { viewId: attempt.state.viewId, outcome });
    return true;
  }

  commit(attempt: ActivityOutcomeAttempt | null, outcome: ChatRunOutcome): boolean {
    if (!attempt || !this.#isCurrent(attempt)) return false;
    this.#byChat.set(attempt.chatId, { viewId: attempt.state.viewId, outcome, live: true });
    return true;
  }
}
