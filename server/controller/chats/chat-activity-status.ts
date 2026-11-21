import type { ChatActivityStatus, ChatRunOutcome } from '../../../common/chat-activity.js';
import type { ChatProcessingPhase } from '../../../common/chat-types.js';

export function projectChatActivityStatus(input: {
  processingPhase: ChatProcessingPhase | null;
  pendingUserAction: boolean;
  lastRunOutcome: ChatRunOutcome | null;
}): ChatActivityStatus | null {
  if (input.processingPhase !== null && input.pendingUserAction) return 'pending-user-action';
  if (input.processingPhase !== null) return 'working';
  return input.lastRunOutcome === 'finished' ? 'complete'
    : input.lastRunOutcome === 'failed' ? 'error' : null;
}
