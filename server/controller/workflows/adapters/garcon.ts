import type { AutomationService } from '../../automation/service.js';
import type { ChatExecutionCoordinator } from '../../chat-execution/chat-execution-coordinator.js';
import { hasPendingTurnInput } from '../../chat-execution/control-state.js';
import type { IChatRegistry } from '../../chats/store.js';
import type { WorkflowChatPort } from '../contracts.js';
import { waitAbortably } from '../../../common/abortable-wait.js';

type ObservationQueue = Pick<ChatExecutionCoordinator,
  'ownsExecution' | 'readChatExecutionControl' | 'on' | 'removeListener'>;

export function createWorkflowChatPort(automation: Pick<AutomationService, 'prepare' | 'waitForTerminal' | 'stop'>,
  queue: ObservationQueue, chats: Pick<IChatRegistry, 'hasChat'>): WorkflowChatPort {
  return {
    prepare: input => automation.prepare(input),
    waitForTerminal: (key, signal) => automation.waitForTerminal(key, signal),
    stop: key => automation.stop(key),
    waitForOwnershipRelease: (chatId, signal) => waitForOwnershipRelease(queue, chatId, signal),
    async inspect(chatId, signal) {
      signal.throwIfAborted();
      const control = await waitAbortably(queue.readChatExecutionControl(chatId), signal);
      signal.throwIfAborted();
      return { exists: chats.hasChat(chatId), ownsExecution: queue.ownsExecution(chatId), pendingInput: hasPendingTurnInput(control) };
    },
  };
}

function waitForOwnershipRelease(queue: ObservationQueue, chatId: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const dispose = () => {
      queue.removeListener('processing-invalidated', changed);
      queue.removeListener('turn-settled', changed);
      queue.removeListener('chat-idle', changed);
      signal.removeEventListener('abort', check);
    };
    const check = () => {
      if (signal.aborted) { dispose(); reject(signal.reason); }
      else if (!queue.ownsExecution(chatId)) { dispose(); resolve(); }
    };
    const changed = (id: string) => { if (id === chatId) check(); };
    queue.on('processing-invalidated', changed);
    queue.on('turn-settled', changed);
    queue.on('chat-idle', changed);
    signal.addEventListener('abort', check, { once: true });
    check();
  });
}
