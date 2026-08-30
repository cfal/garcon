import type { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import type { StoredControlInputEntry } from '../chat-execution/control-state.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { ChatIdRequestSink } from '../ledger/garcon-command-publication.js';
import { transcriptViewId } from '../ledger/contracts.js';
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { SettingsStore } from '../settings/store.js';
import { ChatIdDiscoveryController } from './chat-id-discovery-controller.js';
import { InterAgentMessageComposition } from './inter-agent-message-composition.js';
import type { ChatRegistry } from './store.js';

type AgentCommandSetting = 'chatIdDiscovery' | 'sendMessage';

interface AgentCommandCompositionOptions {
  readonly registry: ChatRegistry;
  readonly adoption: TranscriptAdoptionService;
  readonly execution: ChatExecutionCoordinator;
  readonly notices: TranscriptLedgerService;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly settings: Pick<SettingsStore, 'getFeatureSettings'>;
  readonly onChatIdError: (error: unknown, chatId: string) => void;
}

export class AgentCommandComposition {
  readonly interAgentMessages = new InterAgentMessageComposition();
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
  }

  discardSource(chatId: string): void {
    this.#chatIdDiscovery?.discard(chatId);
    this.interAgentMessages.discardSource(chatId);
  }
}

function commandEnabled(
  settings: Pick<SettingsStore, 'getFeatureSettings'>,
  command: AgentCommandSetting,
): boolean {
  const commands = settings.getFeatureSettings().agentCommands;
  return commands.enabled && commands[command];
}
