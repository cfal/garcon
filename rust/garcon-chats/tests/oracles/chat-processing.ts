import { ChatProcessingActivity } from '../../../../server/controller/chats/chat-processing-activity.js';

type ProcessingFixture = {
  running: string[];
  reserved: string[];
  stopping: string[];
  reconnecting: string[];
};

export function projectProcessing(fixture: ProcessingFixture, chatId: string) {
  const activity = new ChatProcessingActivity(
    {
      isChatRunning: (id) => fixture.running.includes(id),
      getRunningChatIdsSnapshot: () => fixture.running,
    },
    {
      isChatTurnReserved: (id) => fixture.reserved.includes(id),
      getTurnReservedChatIds: () => fixture.reserved,
      isChatStopInFlight: (id) => fixture.stopping.includes(id),
    },
    {
      isChatExecutorReconnecting: (id) => fixture.reconnecting.includes(id),
    },
  );
  return { phase: activity.phase(chatId), snapshot: activity.snapshot() };
}
