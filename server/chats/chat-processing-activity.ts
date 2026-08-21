import type {
  ChatProcessingEntry,
  ChatProcessingPhase,
  ChatTurnRetryStatus,
} from '../../common/chat-types.js';

interface RunningChatSource {
  isChatRunning(chatId: string): boolean;
  getRunningChatIdsSnapshot(): string[];
  turnRetryStatus(chatId: string): ChatTurnRetryStatus | null;
}

interface TurnReservationSource {
  isChatTurnReserved(chatId: string): boolean;
  getTurnReservedChatIds(): string[];
  isChatStopInFlight(chatId: string): boolean;
}

export class ChatProcessingActivity {
  constructor(
    private readonly running: RunningChatSource,
    private readonly reservations: TurnReservationSource,
  ) {}

  // Answers whether the user should see a turn in progress, which is narrower than the
  // coordinator's ownsExecution on purpose: a fork's transcript snapshot and a turn that has
  // finished but not settled both own execution without being work the user started, and
  // surfacing them here would light the processing indicator for a fork.
  phase(chatId: string): ChatProcessingPhase | null {
    if (!this.running.isChatRunning(chatId) && !this.reservations.isChatTurnReserved(chatId)) {
      return null;
    }
    return this.reservations.isChatStopInFlight(chatId) ? 'stopping' : 'running';
  }

  // Presentation detail for the phase, never a busy-ness signal: a retry
  // status exists only while the same projection reports a running turn.
  retry(chatId: string): ChatTurnRetryStatus | null {
    if (this.phase(chatId) === null) return null;
    return this.running.turnRetryStatus(chatId);
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
        return phase ? [{ chatId, phase, retry: this.retry(chatId) }] : [];
      });
  }
}
