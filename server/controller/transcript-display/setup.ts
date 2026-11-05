import { ChatDisplayStateUpdatedMessage } from '../../../common/transcript-display-events.js';
import { createLogger } from '../../common/log.js';
import type { ChatRegistry } from '../chats/store.js';
import type { SettingsStore } from '../settings/store.js';
import type { ServerEventWiring } from '../server-event-wiring.js';
import { TranscriptDisplayService, type TranscriptDisplayOptions } from './service.js';

interface TranscriptDisplaySetup extends Pick<TranscriptDisplayOptions, 'workspaceDirectory' | 'serverInstanceId' | 'ledger' | 'adoption'> {
  readonly registry: Pick<ChatRegistry, 'hasChat' | 'onChatRemoved'>;
  readonly settings: Pick<SettingsStore, 'getUiSettings' | 'onRemoteSettingsChanged'>;
  readonly events: () => ServerEventWiring | null;
}

export function initializeTranscriptDisplay(options: TranscriptDisplaySetup): TranscriptDisplayService {
  const { registry, settings, events, ...source } = options;
  const logger = createLogger('transcript-display');
  const display = new TranscriptDisplayService({
    ...source,
    hasChat: chatId => registry.hasChat(chatId),
    patterns: () => settings.getUiSettings().hiddenBashCommandPatterns ?? [],
    onMaintenanceError: (chatId, code) => logger.warn(`Transcript display cleanup skipped ${chatId}: ${code}`),
    onStatus: status => events()?.broadcastDisplayState(new ChatDisplayStateUpdatedMessage(
      source.serverInstanceId, status.chatId, status.transcriptViewId, status.policyRevision,
      status.bashRevision, status.preparedThrough, status.phase, status.errorCode, status.auxiliaryRevision)),
    onPlanChanged: snapshot => {
      try {
        const head = source.ledger.highWatermark(snapshot.chatId);
        if (head.viewId === snapshot.transcriptViewId)
          events()?.notifyPlanPresentationChanged(snapshot.chatId, head.viewId, head.ordinal, snapshot.revision);
      } catch {
        logger.warn('Plan presentation changed while the source view was unavailable.');
      }
    },
  });
  registry.onChatRemoved(chatId => display.forget(chatId));
  settings.onRemoteSettingsChanged(() => display.settingsChanged());
  void display.initialize().catch(() => logger.warn('Transcript display admission failed; explicit reads may retry.'));
  return display;
}
