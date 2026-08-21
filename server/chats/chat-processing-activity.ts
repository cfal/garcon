import type {
  ChatProcessingEntry,
  ChatProcessingPhase,
} from '../../common/chat-types.js';

interface RunningChatSource {
  isChatRunning(chatId: string): boolean;
  getRunningChatIdsSnapshot(): string[];
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

  snapshot(): ChatProcessingEntry[] {
    const chatIds = new Set([
      ...this.running.getRunningChatIdsSnapshot(),
      ...this.reservations.getTurnReservedChatIds(),
    ]);
    return [...chatIds]
      .sort()
      .flatMap((chatId) => {
        const phase = this.phase(chatId);
        return phase ? [{ chatId, phase }] : [];
      });
  }
}
