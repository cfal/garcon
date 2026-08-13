import type { AgentIntegrationV4 } from '@garcon/server-agent-interface';
import type { IChatRegistry } from '../chats/store.js';
import { createLogger } from '../lib/log.js';
import type { TranscriptLedgerService } from './service.js';

export const NATIVE_TRANSCRIPT_DRIFT_NOTICE =
  'The transcript may have changed outside Garcon. Consider reloading from native history.';

interface NativeActivityIntegrationDirectory {
  get(agentId: string): AgentIntegrationV4 | null;
}

export interface NativeTranscriptActivityServiceOptions {
  readonly ledger: TranscriptLedgerService;
  readonly registry: Pick<IChatRegistry, 'getChat'>;
  readonly integrations: NativeActivityIntegrationDirectory;
}

const logger = createLogger('ledger:native-activity');

export class NativeTranscriptActivityService {
  constructor(private readonly options: NativeTranscriptActivityServiceOptions) {}

  async check(
    chatId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const entry = this.options.registry.getChat(chatId);
    if (!entry) return false;
    const integration = this.options.integrations.get(entry.agentId);
    if (!integration?.nativeActivity) return false;

    const before = this.options.ledger.nativeActivityState(chatId);
    const nativeSession = before.session?.detail.nativeSession ?? null;
    if (!nativeSession) return false;

    let result;
    try {
      result = await integration.nativeActivity.lastActivity(nativeSession, signal);
    } catch (error) {
      logger.warn('Native transcript activity probe failed', {
        chatId,
        agentId: entry.agentId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (result.kind === 'unavailable' || result.value.lastEntryAt === null) return false;

    const observedAt = timestamp(result.value.lastEntryAt);
    if (observedAt === null) {
      logger.warn('Native transcript activity probe returned an invalid timestamp', {
        chatId,
        agentId: entry.agentId,
      });
      return false;
    }

    const current = this.options.ledger.nativeActivityState(chatId);
    if (
      current.viewId !== before.viewId
      || current.session?.ordinal !== before.session?.ordinal
    ) return false;
    const providerAt = timestamp(current.providerWatermarkAt);
    if (providerAt !== null && observedAt <= providerAt) return false;
    const warnedAt = timestamp(current.lastNoticeWatermarkAt);
    if (warnedAt !== null && observedAt <= warnedAt) return false;

    this.options.ledger.appendNotice({
      chatId,
      viewId: current.viewId,
      message: NATIVE_TRANSCRIPT_DRIFT_NOTICE,
      detail: {
        type: 'native-transcript-drift',
        observedNativeWatermark: result.value.lastEntryAt,
      },
    });
    return true;
  }
}

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
