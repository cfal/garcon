import type { AgentRegistry } from '../agents/registry.js';
import type { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import type { MetadataIndex } from '../chats/metadata-store.js';
import type { IChatRegistry } from '../chats/store.js';
import type { SettingsStore } from '../settings/store.js';
import { AttentionTracker } from './attention-tracker.js';
import { TelegramSettingsStore } from './telegram-settings-store.js';
import { TelegramNotifier } from './telegram.js';

export async function setupNotifications(options: {
  readonly agents: Pick<AgentRegistry, 'onTranscriptCommitted' | 'chatExecutionPolicy'>;
  readonly queue: Pick<ChatExecutionCoordinator, 'onChatIdle' | 'onSessionStopped' | 'onTurnFailed'>;
  readonly settings: SettingsStore;
  readonly registry: IChatRegistry;
  readonly metadata: MetadataIndex;
}): Promise<{ telegramSettings: TelegramSettingsStore; telegramNotifier: TelegramNotifier }> {
  const telegramSettings = new TelegramSettingsStore();
  await telegramSettings.init();
  const telegramNotifier = new TelegramNotifier(telegramSettings.getBotToken());
  new AttentionTracker(options.agents, options.queue, options.settings, options.registry,
    options.metadata, telegramNotifier, telegramSettings);
  return { telegramSettings, telegramNotifier };
}
