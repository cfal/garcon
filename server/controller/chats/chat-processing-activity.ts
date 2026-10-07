import type {
  ChatProcessingEntry,
  ChatProcessingPhase,
  ChatProcessingTiming,
} from '../../../common/chat-types.js';

interface RunningChatSource {
  isChatRunning(chatId: string): boolean;
  getRunningChatIdsSnapshot(): string[];
}

interface ExecutorReconnectSource {
  isChatExecutorReconnecting(chatId: string): boolean;
}

interface TurnReservationSource {
  isChatTurnReserved(chatId: string): boolean;
  getTurnReservedChatIds(): string[];
  isChatStopInFlight(chatId: string): boolean;
}

export class ChatProcessingActivity {
  readonly #timing = new Map<string, Omit<ChatProcessingTiming, 'observedAt'>>();
  constructor(
    private readonly running: RunningChatSource,
    private readonly reservations: TurnReservationSource,
    private readonly executors: ExecutorReconnectSource,
  ) {}

  update(chatId: string): ChatProcessingTiming | null {
    if (this.phase(chatId) === null) {
      this.#timing.delete(chatId);
      return null;
    }
    if (!this.#timing.has(chatId)) this.#timing.set(chatId, { startedAt: Date.now(), lastOutputAt: null });
    return this.timing(chatId);
  }

  observeOutput(chatId: string): void {
    const timing = this.#timing.get(chatId);
    if (timing && this.phase(chatId) !== null) {
      this.#timing.set(chatId, { ...timing, lastOutputAt: Date.now() });
    }
  }

  timing(chatId: string): ChatProcessingTiming | null {
    const timing = this.#timing.get(chatId);
    return timing && this.phase(chatId) !== null ? { ...timing, observedAt: Date.now() } : null;
  }

  remove(chatId: string): void { this.#timing.delete(chatId); }

  // Answers whether the user should see a turn in progress, which is narrower than the
  // coordinator's ownsExecution on purpose: a fork's transcript snapshot and a turn that has
  // finished but not settled both own execution without being work the user started, and
  // surfacing them here would light the processing indicator for a fork.
  phase(chatId: string): ChatProcessingPhase | null {
    if (!this.running.isChatRunning(chatId) && !this.reservations.isChatTurnReserved(chatId)) {
      return null;
    }
    if (this.reservations.isChatStopInFlight(chatId)) return 'stopping';
    return this.executors.isChatExecutorReconnecting(chatId) ? 'reconnecting' : 'running';
  }

  snapshot(): ChatProcessingEntry[] {
    const chatIds = new Set([
      ...this.running.getRunningChatIdsSnapshot(),
      ...this.reservations.getTurnReservedChatIds(),
    ]);
    return [...chatIds]
      .sort()
      .flatMap((chatId) => {
        const phase = this.phase(chatId);
        const timing = this.timing(chatId);
        return phase ? [{ chatId, phase, ...(timing ? { timing } : {}) }] : [];
      });
  }
}
