import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { IChatRegistry } from '../chats/store.js';
import { createLogger } from '../lib/log.js';
import type { TranscriptLedgerService } from './service.js';

export const NATIVE_TRANSCRIPT_DRIFT_NOTICE =
  'The transcript may have changed outside Garcon. Consider reloading from native history.';

interface NativeActivityIntegrationDirectory {
  get(agentId: string): AgentIntegration | null;
}

export interface NativeTranscriptActivityServiceOptions {
  readonly ledger: TranscriptLedgerService;
  readonly registry: Pick<IChatRegistry, 'getChat'>;
  readonly integrations: NativeActivityIntegrationDirectory;
  readonly ownsExecution: (chatId: string) => boolean;
  readonly probeTimeoutMs?: number;
}

const logger = createLogger('ledger:native-activity');
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export type NativeActivityCheckReason = 'open' | 'pre-resume';

export class NativeTranscriptActivityService {
  readonly #pendingChecks = new Map<string, symbol>();
  readonly #probeTimeoutMs: number;

  constructor(private readonly options: NativeTranscriptActivityServiceOptions) {
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#probeTimeoutMs) || this.#probeTimeoutMs < 1) {
      throw new TypeError('Native transcript activity probe timeout must be a positive integer');
    }
  }

  requestCheck(chatId: string, reason: NativeActivityCheckReason): void {
    if (this.#pendingChecks.has(chatId)) return;
    const token = Symbol(chatId);
    this.#pendingChecks.set(chatId, token);
    const clear = () => {
      if (this.#pendingChecks.get(chatId) === token) this.#pendingChecks.delete(chatId);
    };
    void this.#runRequestedCheck(chatId, reason, clear).catch((error) => {
      logger.warn('Native transcript activity check failed', {
        chatId,
        reason,
        code: errorCode(error),
      });
    });
  }

  check(
    chatId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<boolean> {
    return this.#check(chatId, signal, () => {});
  }

  async #check(
    chatId: string,
    signal: AbortSignal,
    settled: () => void,
    reason?: NativeActivityCheckReason,
  ): Promise<boolean> {
    try {
      signal.throwIfAborted();
      if (this.options.ownsExecution(chatId)) return false;
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
        if (signal.aborted) return false;
        logger.warn('Native transcript activity probe failed', {
          chatId,
          agentId: entry.agentId,
          ...(reason ? { reason } : {}),
          code: errorCode(error),
        });
        return false;
      }
      if (signal.aborted || this.options.ownsExecution(chatId)) return false;
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
      if (activityStateChanged(before, current)) return false;
      if (this.options.registry.getChat(chatId)?.agentId !== entry.agentId) return false;
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
          action: 'reload-native-history',
          observedNativeWatermark: result.value.lastEntryAt,
        },
      });
      return true;
    } finally {
      settled();
    }
  }

  async #runRequestedCheck(
    chatId: string,
    reason: NativeActivityCheckReason,
    clear: () => void,
  ): Promise<void> {
    const controller = new AbortController();
    let resolveTimeout!: () => void;
    const timeoutReached = new Promise<void>((resolve) => {
      resolveTimeout = resolve;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      clear();
      logger.warn('Native transcript activity check timed out', {
        chatId,
        reason,
        code: 'NATIVE_ACTIVITY_CHECK_TIMEOUT',
      });
      resolveTimeout();
    }, this.#probeTimeoutMs);
    timeout.unref?.();
    try {
      await Promise.race([
        this.#check(chatId, controller.signal, clear, reason).then(() => undefined),
        timeoutReached,
      ]);
    } finally {
      clearTimeout(timeout);
      clear();
    }
  }
}

function activityStateChanged(
  before: ReturnType<TranscriptLedgerService['nativeActivityState']>,
  current: ReturnType<TranscriptLedgerService['nativeActivityState']>,
): boolean {
  return current.viewId !== before.viewId
    || current.session?.ordinal !== before.session?.ordinal
    || current.providerWatermarkAt !== before.providerWatermarkAt
    || current.lastNoticeWatermarkAt !== before.lastNoticeWatermarkAt;
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
    ? error.message
    : 'NATIVE_ACTIVITY_CHECK_FAILED';
}

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
