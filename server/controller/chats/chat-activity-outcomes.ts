import type { ChatRunOutcome } from '../../../common/chat-activity.js';

interface ActivityOutcome {
  readonly viewId: string;
  readonly outcome: ChatRunOutcome | null;
  readonly terminalRunId?: string;
  readonly live?: boolean;
}

export interface ActivityFailureAttempt {
  readonly chatId: string;
  readonly state: ActivityOutcome;
  readonly runId?: string;
}

// Keeps process-only results independent of preview validation and fences delayed settlement.
export class ChatActivityOutcomes {
  readonly #byChat = new Map<string, ActivityOutcome>();
  readonly #attempts = new Map<string, ActivityFailureAttempt>();

  constructor(private readonly currentView: (chatId: string) => string | null) {}

  get(chatId: string): ChatRunOutcome | null {
    const current = this.#byChat.get(chatId);
    return current?.viewId === this.currentView(chatId) ? current.outcome : null;
  }

  clear(chatId: string, runId?: string): void {
    const viewId = this.currentView(chatId);
    if (viewId) this.#byChat.set(chatId, { viewId, outcome: null, live: true });
    if (runId) this.begin(chatId, runId);
  }

  begin(chatId: string, runId: string): void {
    const viewId = this.currentView(chatId);
    if (!viewId) return;
    const previous = this.#byChat.get(chatId);
    this.#byChat.set(chatId, {
      ...(previous?.viewId === viewId ? previous : { viewId, outcome: null }), live: true,
    });
    const attempt = this.capture(chatId, runId);
    if (attempt) this.#attempts.set(chatId, attempt);
  }

  captureFailure(chatId: string, runId?: string): ActivityFailureAttempt | null {
    const attempt = this.#attempts.get(chatId);
    if (attempt && runId) return attempt.runId === runId ? attempt : null;
    return this.capture(chatId, runId);
  }

  delete(chatId: string): void {
    this.#byChat.delete(chatId);
    this.#attempts.delete(chatId);
  }

  capture(chatId: string, runId?: string): ActivityFailureAttempt | null {
    const viewId = this.currentView(chatId);
    if (!viewId) return null;
    let current = this.#byChat.get(chatId);
    if (current?.viewId !== viewId) {
      current = { viewId, outcome: null };
      this.#byChat.set(chatId, current);
    }
    return { chatId, state: current, runId };
  }

  fail(attempt: ActivityFailureAttempt | null): boolean {
    if (!attempt || !this.isCurrent(attempt)
      || (attempt.runId !== undefined && attempt.state.terminalRunId === attempt.runId)) return false;
    this.#byChat.set(attempt.chatId, { viewId: attempt.state.viewId, outcome: 'failed', live: true });
    return true;
  }

  isCurrent(attempt: ActivityFailureAttempt): boolean {
    return this.#byChat.get(attempt.chatId) === attempt.state
      && this.currentView(attempt.chatId) === attempt.state.viewId;
  }

  restore(attempt: ActivityFailureAttempt, outcome: ChatRunOutcome | null): void {
    if (!attempt.state.live && this.isCurrent(attempt)) {
      this.#byChat.set(attempt.chatId, { viewId: attempt.state.viewId, outcome });
    }
  }

  commit(attempt: ActivityFailureAttempt | null, viewId: string, outcome: ChatRunOutcome): boolean {
    return attempt !== null && this.isCurrent(attempt)
      && this.update(attempt.chatId, viewId, outcome, attempt.runId);
  }

  update(chatId: string, viewId: string, outcome: ChatRunOutcome | null, runId?: string): boolean {
    if (this.currentView(chatId) !== viewId) return false;
    this.#byChat.set(chatId, { viewId, outcome, terminalRunId: runId, live: true });
    return true;
  }
}
