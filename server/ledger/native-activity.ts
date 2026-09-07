import type {
  AgentIntegration,
  AgentNativeActivityProbe,
  AgentNativeActivityResult,
  AgentNativeSessionRef,
} from '@garcon/server-agent-interface';
import { isDeepStrictEqual } from 'node:util';
import type { ChatOperationalNoticeMessage } from '../../common/ws-events.js';
import type { IChatRegistry } from '../chats/store.js';
import { createLogger } from '../lib/log.js';
import type { NativeActivityProviderWatermark } from './contracts.js';
import type { TranscriptLedgerService } from './service.js';

export const NATIVE_TRANSCRIPT_DRIFT_NOTICE =
  'The transcript may have changed outside Garcon. Consider reloading from native history.';

interface NativeActivityIntegrationDirectory {
  get(agentId: string): AgentIntegration | null;
}

interface ScheduledTimeout {
  cancel(): void;
}

interface NativeActivityEligibilityKey {
  readonly agentId: string;
  readonly transcriptViewId: string;
  readonly sessionOrdinal: number;
  readonly nativeSession: AgentNativeSessionRef;
  readonly providerWatermark: NativeActivityProviderWatermark;
}

interface EligibleNativeActivityCheck {
  readonly key: NativeActivityEligibilityKey;
  readonly probe: AgentNativeActivityProbe;
}

interface PendingNativeActivityCheck {
  readonly key: NativeActivityEligibilityKey;
  readonly controller: AbortController;
  readonly token: symbol;
}

export interface NativeTranscriptActivityServiceOptions {
  readonly ledger: Pick<TranscriptLedgerService, 'nativeActivityState'>;
  readonly registry: Pick<IChatRegistry, 'getChat'>;
  readonly integrations: NativeActivityIntegrationDirectory;
  readonly ownsExecution: (chatId: string) => boolean;
  readonly notifyOperationalNotice: (
    chatId: string,
    noticeType: ChatOperationalNoticeMessage['noticeType'],
    content: string,
  ) => void;
  readonly scheduleTimeout?: (callback: () => void, delay: number) => ScheduledTimeout;
}

const logger = createLogger('ledger:native-activity');
const PROBE_TIMEOUT_MS = 5_000;

export type NativeActivityCheckReason = 'activation';

export class NativeTranscriptActivityService {
  readonly #pendingChecks = new Map<string, PendingNativeActivityCheck>();
  readonly #scheduleTimeout: NonNullable<NativeTranscriptActivityServiceOptions['scheduleTimeout']>;

  constructor(private readonly options: NativeTranscriptActivityServiceOptions) {
    this.#scheduleTimeout = options.scheduleTimeout ?? scheduleTimeout;
  }

  requestCheck(chatId: string, reason: NativeActivityCheckReason): void {
    const current = this.#pendingChecks.get(chatId);
    let eligible: EligibleNativeActivityCheck | null;
    try {
      eligible = this.options.ownsExecution(chatId) ? null : this.#eligibility(chatId);
    } catch {
      current?.controller.abort();
      this.#pendingChecks.delete(chatId);
      this.#log('Native transcript activity eligibility failed', chatId, reason,
        'NATIVE_ACTIVITY_ELIGIBILITY_FAILED');
      return;
    }

    if (!eligible) {
      if (current) {
        current.controller.abort();
        this.#pendingChecks.delete(chatId);
      }
      return;
    }
    if (current && eligibilityKeysEqual(current.key, eligible.key)) return;
    current?.controller.abort();

    const attempt: PendingNativeActivityCheck = {
      key: eligible.key,
      controller: new AbortController(),
      token: Symbol(chatId),
    };
    this.#pendingChecks.set(chatId, attempt);
    void this.#runAttempt(chatId, reason, attempt, eligible.probe)
      .catch(() => {
        this.#log('Native transcript activity check failed', chatId, reason,
          'NATIVE_ACTIVITY_CHECK_FAILED');
      });
  }

  async #runAttempt(
    chatId: string,
    reason: NativeActivityCheckReason,
    attempt: PendingNativeActivityCheck,
    probe: AgentNativeActivityProbe,
  ): Promise<void> {
    const { controller, key } = attempt;
    const timeout = this.#scheduleTimeout(() => {
      this.#log('Native transcript activity check timed out', chatId, reason,
        'NATIVE_ACTIVITY_CHECK_TIMEOUT');
      controller.abort();
    }, PROBE_TIMEOUT_MS);
    const aborted = waitForAbort(controller.signal);

    try {
      const result = probeResult(probe, key.nativeSession, controller.signal);
      const outcome = await Promise.race([result, aborted.promise]);
      if (outcome.kind === 'aborted') return;
      if (outcome.kind === 'failed') {
        if (!controller.signal.aborted) {
          this.#log('Native transcript activity probe failed', chatId, reason,
            'NATIVE_ACTIVITY_PROBE_FAILED', key.agentId);
        }
        return;
      }
      if (controller.signal.aborted) return;
      this.#presentResult(chatId, reason, key, outcome.value);
    } finally {
      aborted.cancel();
      timeout.cancel();
      if (this.#pendingChecks.get(chatId)?.token === attempt.token) {
        this.#pendingChecks.delete(chatId);
      }
    }
  }

  #presentResult(
    chatId: string,
    reason: NativeActivityCheckReason,
    attempted: NativeActivityEligibilityKey,
    result: AgentNativeActivityResult,
  ): void {
    if (result.kind === 'unavailable' || result.value.lastEntryAt === null) return;
    const observedAt = timestamp(result.value.lastEntryAt);
    if (observedAt === null) {
      this.#log('Native transcript activity probe returned an invalid timestamp', chatId, reason,
        'NATIVE_ACTIVITY_INVALID_TIMESTAMP', attempted.agentId);
      return;
    }
    if (this.options.ownsExecution(chatId)) return;

    const current = this.#eligibility(chatId);
    if (!current || !eligibilityKeysEqual(attempted, current.key)) return;
    const providerAt = timestamp(current.key.providerWatermark.at);
    if (providerAt === null || observedAt <= providerAt) return;

    this.options.notifyOperationalNotice(chatId, 'warning', NATIVE_TRANSCRIPT_DRIFT_NOTICE);
  }

  #eligibility(chatId: string): EligibleNativeActivityCheck | null {
    const entry = this.options.registry.getChat(chatId);
    if (!entry) return null;
    const integration = this.options.integrations.get(entry.agentId);
    if (!integration?.nativeActivity) return null;
    const activity = this.options.ledger.nativeActivityState(chatId);
    const session = activity.session;
    const nativeSession = session?.detail.nativeSession ?? null;
    const providerWatermark = activity.providerWatermark;
    if (!session || !nativeSession || !providerWatermark) return null;
    return {
      key: {
        agentId: entry.agentId,
        transcriptViewId: activity.viewId,
        sessionOrdinal: session.ordinal,
        nativeSession,
        providerWatermark,
      },
      probe: integration.nativeActivity,
    };
  }

  #log(
    message: string,
    chatId: string,
    reason: NativeActivityCheckReason,
    code: string,
    agentId?: string,
  ): void {
    logger.warn(message, { chatId, reason, code, ...(agentId ? { agentId } : {}) });
  }
}

function eligibilityKeysEqual(
  left: NativeActivityEligibilityKey,
  right: NativeActivityEligibilityKey,
): boolean {
  return left.agentId === right.agentId
    && left.transcriptViewId === right.transcriptViewId
    && left.sessionOrdinal === right.sessionOrdinal
    && left.providerWatermark.ordinal === right.providerWatermark.ordinal
    && left.providerWatermark.at === right.providerWatermark.at
    && isDeepStrictEqual(left.nativeSession, right.nativeSession);
}

function probeResult(
  probe: AgentNativeActivityProbe,
  nativeSession: AgentNativeSessionRef,
  signal: AbortSignal,
): Promise<
  | { readonly kind: 'result'; readonly value: AgentNativeActivityResult }
  | { readonly kind: 'failed' }
> {
  try {
    return probe.lastActivity(nativeSession, signal).then(
      (value) => ({ kind: 'result' as const, value }),
      () => ({ kind: 'failed' as const }),
    );
  } catch {
    return Promise.resolve({ kind: 'failed' });
  }
}

function waitForAbort(signal: AbortSignal): {
  readonly promise: Promise<{ readonly kind: 'aborted' }>;
  cancel(): void;
} {
  let resolve!: (value: { readonly kind: 'aborted' }) => void;
  const promise = new Promise<{ readonly kind: 'aborted' }>((done) => {
    resolve = done;
  });
  const onAbort = () => resolve({ kind: 'aborted' });
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return {
    promise,
    cancel: () => signal.removeEventListener('abort', onAbort),
  };
}

function scheduleTimeout(callback: () => void, delay: number): ScheduledTimeout {
  const timeout = setTimeout(callback, delay);
  timeout.unref?.();
  return { cancel: () => clearTimeout(timeout) };
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
