import type { AgentCommandsFeatureSettings } from '../../common/settings.js';
import type { AgentRegistry } from '../agents/index.js';
import type { ApiProviderService } from '../api-providers/service.js';
import type { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import type { StoredControlInputEntry } from '../chat-execution/control-state.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { ChatIdRequestSink } from '../ledger/garcon-command-publication.js';
import { transcriptViewId } from '../ledger/contracts.js';
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { SettingsStore } from '../settings/store.js';
import { AgentStartComposition } from './agent-start-composition.js';
import type { ChatIdAllocator } from './chat-id-allocator.js';
import { ChatIdDiscoveryController } from './chat-id-discovery-controller.js';
import { InterAgentMessageComposition } from './inter-agent-message-composition.js';
import type { ChatRegistry } from './store.js';

type AgentCommandSetting = Exclude<keyof AgentCommandsFeatureSettings, 'enabled'>;

interface AgentCommandCompositionOptions {
  readonly registry: ChatRegistry;
  readonly adoption: TranscriptAdoptionService;
  readonly execution: ChatExecutionCoordinator;
  readonly notices: TranscriptLedgerService;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly settings: Pick<SettingsStore, 'getExecutionDefaults' | 'getFeatureSettings'>;
  readonly commands: ChatCommandService;
  readonly chatIds: ChatIdAllocator;
  readonly agents: AgentRegistry;
  readonly apiProviders: ApiProviderService;
  readonly onChatIdError: (error: unknown, chatId: string) => void;
}

export class AgentCommandComposition {
  readonly interAgentMessages = new InterAgentMessageComposition();
  readonly agentStarts = new AgentStartComposition();
  #chatIdDiscovery: ChatIdDiscoveryController | null = null;
  #notices: TranscriptLedgerService | null = null;

  readonly chatIdRequests: ChatIdRequestSink = {
    request: (input) => {
      if (!this.#chatIdDiscovery) {
        throw new Error('Chat ID discovery controller is not initialized');
      }
      this.#chatIdDiscovery.request(input);
    },
  };

  readonly appendControlReceipt = (chatId: string, entry: StoredControlInputEntry): void => {
    if (!this.#notices) throw new Error('Agent command notices are not initialized');
    this.#notices.appendNotice(chatId, transcriptViewId(entry.transcriptViewId), {
      ...entry.receipt,
      at: entry.createdAt,
    });
  };

  initialize(options: AgentCommandCompositionOptions): void {
    if (this.#chatIdDiscovery) throw new Error('Agent command controllers are already initialized');
    this.#notices = options.notices;
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
    this.agentStarts.initialize({
      registry: options.registry,
      selection: {
        agents: options.agents,
        apiProviders: options.apiProviders,
      },
      commands: options.commands,
      chatIds: options.chatIds,
      execution: options.execution,
      notices: options.notices,
      chatMutationLock: options.chatMutationLock,
      getExecutionDefaults: () => options.settings.getExecutionDefaults(),
      isEnabled: () => commandEnabled(options.settings, 'subAgents'),
    });
  }

  discardSource(chatId: string): void {
    this.#chatIdDiscovery?.discard(chatId);
    this.interAgentMessages.discardSource(chatId);
    this.agentStarts.discardSource(chatId);
  }

  beginShutdown(): void {
    this.agentStarts.beginShutdown();
  }

  async waitForIdle(): Promise<void> {
    await this.agentStarts.waitForIdle();
  }
}

function commandEnabled(
  settings: Pick<SettingsStore, 'getFeatureSettings'>,
  command: AgentCommandSetting,
): boolean {
  const commands = settings.getFeatureSettings().agentCommands;
  return commands.enabled && commands[command];
}
