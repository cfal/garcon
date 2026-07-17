interface RunningChatSource {
  isChatRunning(chatId: string): boolean;
}

interface ReservedChatExecutionSource {
  isChatExecutionReserved(chatId: string): boolean;
}

// Owns the process-wide definition of active chat execution. Transcript
// retention and native reload gating must consume this same predicate.
export class ChatExecutionActivity {
  #runningChats: RunningChatSource;
  #reservedExecutions: ReservedChatExecutionSource | null = null;

  constructor(runningChats: RunningChatSource) {
    this.#runningChats = runningChats;
  }

  attachReservedExecutions(source: ReservedChatExecutionSource): void {
    if (this.#reservedExecutions) {
      throw new Error('Chat execution reservations are already attached');
    }
    this.#reservedExecutions = source;
  }

  readonly isActive = (chatId: string): boolean =>
    this.#runningChats.isChatRunning(chatId)
    || Boolean(this.#reservedExecutions?.isChatExecutionReserved(chatId));
}
