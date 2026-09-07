import type { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import type { StoredControlInputEntry } from '../chat-execution/control-state.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { ChatIdRequestSink, AgentStartRequestSink, AgentScheduleRequestSink } from '../ledger/garcon-command-publication.js';
import { transcriptViewId } from '../ledger/contracts.js';
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { SettingsStore } from '../settings/store.js';
import { ChatIdDiscoveryController } from './chat-id-discovery-controller.js';
import { InterAgentMessageComposition } from './inter-agent-message-composition.js';
import type { ChatRegistry } from './store.js';
import { AgentStartController } from './agent-start-controller.js';
import { AgentScheduleController } from './agent-schedule-controller.js';
import type { AgentStartSelectionService } from '../agents/agent-start-selection-service.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import type { ChatIdAllocator } from './chat-id-allocator.js';
import type { ScheduledPromptScheduler } from '../scheduled-prompts/scheduler.js';

type AgentCommandSetting = 'chatIdDiscovery' | 'sendMessage' | 'startAgent' | 'schedule';

interface AgentCommandCompositionOptions {
  readonly registry: ChatRegistry;
  readonly adoption: TranscriptAdoptionService;
  readonly execution: ChatExecutionCoordinator;
  readonly notices: TranscriptLedgerService;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly settings: Pick<SettingsStore, 'getFeatureSettings' | 'getExecutionDefaults'>;
  readonly selection: AgentStartSelectionService;
  readonly commands: ChatCommandService;
  readonly chatIds: ChatIdAllocator;
  readonly scheduler: ScheduledPromptScheduler;
  readonly onChatIdError: (error: unknown, chatId: string) => void;
}

export class AgentCommandComposition {
  readonly interAgentMessages = new InterAgentMessageComposition();
  #chatIdDiscovery: ChatIdDiscoveryController | null = null;
  #notices: TranscriptLedgerService | null = null;
  #starts: AgentStartController | null = null;
  #schedules: AgentScheduleController | null = null;

  readonly agentStarts: AgentStartRequestSink = {
    request: (source, command) => {
      if (!this.#starts) throw new Error('Agent start controller is not initialized');
      this.#starts.request(source, command);
    },
  };

  readonly agentSchedules: AgentScheduleRequestSink = {
    request: (source, command) => {
      if (!this.#schedules) throw new Error('Agent schedule controller is not initialized');
      this.#schedules.request(source, command);
    },
  };

  readonly chatIdRequests: ChatIdRequestSink = {
    request: (input) => {
      if (!this.#chatIdDiscovery) {
        throw new Error('Chat ID discovery controller is not initialized');
      }
      this.#chatIdDiscovery.request(input);
    },
  };

  readonly appendControlReceipt = (chatId: string, entry: StoredControlInputEntry): void => {
    if (entry.receipt === null) return;
    if (!this.#notices) throw new Error('Agent command notices are not initialized');
    this.#notices.appendNotice(chatId, transcriptViewId(entry.transcriptViewId), {
      ...entry.receipt,
      at: entry.createdAt,
    });
  };

  initialize(options: AgentCommandCompositionOptions): void {
    if (this.#chatIdDiscovery) throw new Error('Agent command controllers are already initialized');
    this.#notices = options.notices;
    this.#starts = new AgentStartController({
      ...options,
      isEnabled: () => commandEnabled(options.settings, 'startAgent'),
    });
    this.#schedules = new AgentScheduleController({
      ...options,
      isEnabled: () => commandEnabled(options.settings, 'schedule'),
    });
    this.#chatIdDiscovery = new ChatIdDiscoveryController({
      execution: options.execution,
      notices: options.notices,
      isEnabled: () => commandEnabled(options.settings, 'chatIdDiscovery'),
      onError: options.onChatIdError,
    });
    this.interAgentMessages.initialize({
      registry: options.registry,
      adoption: options.adoption,
      execution: options.execution,
      notices: options.notices,
      chatMutationLock: options.chatMutationLock,
      isEnabled: () => commandEnabled(options.settings, 'sendMessage'),
    });
  }

  discardSource(chatId: string): void {
    this.#starts?.discardSource(chatId);
    this.#schedules?.discardSource(chatId);
    this.#chatIdDiscovery?.discard(chatId);
    this.interAgentMessages.discardSource(chatId);
  }

  shutdown(): void {
    this.#starts?.shutdown();
    this.#schedules?.shutdown();
  }
}

function commandEnabled(
  settings: Pick<SettingsStore, 'getFeatureSettings'>,
  command: AgentCommandSetting,
): boolean {
  const commands = settings.getFeatureSettings().agentCommands;
  return commands.enabled && commands[command];
}
