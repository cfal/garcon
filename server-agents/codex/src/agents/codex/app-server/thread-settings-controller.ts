import type { PermissionMode } from '@garcon/common/chat-modes';
import {
  AgentIntegrationError,
  type AgentLogger,
} from '@garcon/server-agent-interface';
import {
  cancelPendingApprovals,
  type CodexPendingApproval,
} from './approvals.js';
import {
  CodexAppServerRpcError,
  type CodexAppServerClient,
} from './client.js';
import type { CodexOperation } from './operation-routes.js';
import {
  CodexProtocolParseError,
  parseThreadSettingsUpdatedNotification,
  type ModelListResponse,
  type ThreadSettingsUpdatedNotification,
} from './protocol.js';
import {
  cancelThreadSettingsConfirmation,
  cancelTurnStartWaiters,
  registerThreadSettingsConfirmation,
  sessionForClientThread,
  type RunningCodexSession,
} from './runtime-session-state.js';
import {
  codexFastModeError,
  type CodexServiceTier,
} from '../service-tier.js';

const CODEX_MODEL_LIST_TIMEOUT_MS = 15_000;
const CODEX_MODEL_LIST_MAX_PAGES = 32;
const CODEX_THREAD_SETTINGS_TIMEOUT_MS = 15_000;

export type CodexSessionSettingsUpdateOutcome =
  | {
      readonly kind: 'applied';
      readonly confirmedModel: string;
      readonly confirmedServiceTier: CodexServiceTier;
    }
  | { readonly kind: 'session-absent' };

export interface CodexSessionSettingsPatch {
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly serviceTier: CodexServiceTier;
}

type CodexSessionSettingsUpdateAttemptOutcome =
  | CodexSessionSettingsUpdateOutcome
  | { readonly kind: 'retry-current-session' };

type PendingApproval = CodexPendingApproval & {
  client: CodexAppServerClient;
  operation: CodexOperation;
};

interface CodexThreadSettingsControllerOptions {
  readonly sessions: Map<string, RunningCodexSession>;
  readonly sources: Map<CodexAppServerClient, RunningCodexSession>;
  readonly pendingApprovals: Set<PendingApproval>;
  readonly logger: AgentLogger;
  readonly modelListTimeoutMs?: number;
  readonly modelListMaxPages?: number;
  readonly threadSettingsTimeoutMs?: number;
  flushPendingFinish(session: RunningCodexSession): void;
  publishFailed(
    session: RunningCodexSession,
    message: string,
    operation: CodexOperation,
  ): void;
  shutdownClient(client: CodexAppServerClient): Promise<void>;
}

class CodexSettingsTimeoutError extends Error {
  constructor(readonly phase: 'model-list' | 'thread-settings') {
    super(
      phase === 'model-list'
        ? 'Codex model catalog request timed out'
        : 'Codex thread settings confirmation timed out',
    );
    this.name = 'CodexSettingsTimeoutError';
  }
}

export class CodexThreadSettingsController {
  readonly #modelListTimeoutMs: number;
  readonly #modelListMaxPages: number;
  readonly #threadSettingsTimeoutMs: number;

  constructor(private readonly options: CodexThreadSettingsControllerOptions) {
    this.#modelListTimeoutMs = options.modelListTimeoutMs ?? CODEX_MODEL_LIST_TIMEOUT_MS;
    this.#modelListMaxPages = options.modelListMaxPages ?? CODEX_MODEL_LIST_MAX_PAGES;
    this.#threadSettingsTimeoutMs = options.threadSettingsTimeoutMs
      ?? CODEX_THREAD_SETTINGS_TIMEOUT_MS;
  }

  async update(
    agentSessionId: string,
    patch: CodexSessionSettingsPatch,
  ): Promise<CodexSessionSettingsUpdateOutcome> {
    while (true) {
      const session = this.options.sessions.get(agentSessionId);
      if (!session) return { kind: 'session-absent' };
      const attempt = await this.#queue(
        session,
        () => this.#attempt(agentSessionId, session, patch),
      );
      if (attempt.kind !== 'retry-current-session') return attempt;
    }
  }

  handleNotification(client: CodexAppServerClient, value: unknown): void {
    let notification: ThreadSettingsUpdatedNotification;
    try {
      notification = parseThreadSettingsUpdatedNotification(value);
    } catch (error) {
      const session = this.options.sources.get(client);
      if (!session) return;
      session.confirmedModel = null;
      session.confirmedServiceTier = null;
      session.prioritySupportModel = null;
      session.pendingThreadSettingsConfirmation?.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
      this.options.logger.warn('Codex reported malformed thread settings', {
        chatId: session.chatId,
        threadId: session.threadId,
      });
      return;
    }

    const session = sessionForClientThread(
      this.options.sessions,
      client,
      notification.threadId,
    );
    if (!session) return;
    const settings = notification.threadSettings;
    const confirmation = session.pendingThreadSettingsConfirmation;
    if (
      confirmation
      && settings.model === confirmation.expectedModel
      && settings.serviceTier === confirmation.expectedServiceTier
    ) {
      confirmation.resolve(settings);
      return;
    }
    session.confirmedModel = settings.model;
    if (settings.serviceTier === 'default') {
      session.confirmedServiceTier = 'default';
      session.prioritySupportModel = null;
      return;
    }
    if (
      settings.serviceTier === 'priority'
      && session.prioritySupportModel === settings.model
    ) {
      session.confirmedServiceTier = 'priority';
      return;
    }
    session.confirmedServiceTier = null;
    session.prioritySupportModel = null;
  }

  #queue<T>(session: RunningCodexSession, operation: () => Promise<T>): Promise<T> {
    const scheduled = session.threadSettingsUpdateChain.catch(() => undefined).then(operation);
    session.threadSettingsUpdateChain = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  async #attempt(
    agentSessionId: string,
    session: RunningCodexSession,
    patch: CodexSessionSettingsPatch,
  ): Promise<CodexSessionSettingsUpdateAttemptOutcome> {
    const fence = (): CodexSessionSettingsUpdateAttemptOutcome | null => {
      const current = this.options.sessions.get(agentSessionId);
      if (current === session) return null;
      return current
        ? { kind: 'retry-current-session' }
        : { kind: 'session-absent' };
    };
    const initialFence = fence();
    if (initialFence) return initialFence;

    session.activeDeliveryReservations += 1;
    let ambiguousFailure: AgentIntegrationError | null = null;
    try {
      if (
        patch.serviceTier === 'priority'
        && session.prioritySupportModel !== patch.model
      ) {
        try {
          await this.#withTimeout(
            this.#assertModelAdvertisesPriority(session.client, patch.model),
            this.#modelListTimeoutMs,
            new CodexSettingsTimeoutError('model-list'),
          );
        } catch (error) {
          const supportFence = fence();
          if (supportFence) return supportFence;
          throw this.#classifyModelListFailure(error, patch.model);
        }
        const supportFence = fence();
        if (supportFence) return supportFence;
      }

      let confirmedModel = session.confirmedModel;
      let confirmedServiceTier = session.confirmedServiceTier;
      if (
        confirmedModel !== patch.model
        || confirmedServiceTier !== patch.serviceTier
      ) {
        const confirmation = registerThreadSettingsConfirmation(session, {
          model: patch.model,
          serviceTier: patch.serviceTier,
        });
        try {
          const outcomes = await this.#withTimeout(
            Promise.all([
              session.client.updateThreadSettings({
                threadId: session.threadId,
                model: patch.model,
                serviceTier: patch.serviceTier,
              }),
              confirmation.promise,
            ]),
            this.#threadSettingsTimeoutMs,
            new CodexSettingsTimeoutError('thread-settings'),
          );
          const updateFence = fence();
          if (updateFence) return updateFence;
          const confirmed = this.#assertAppliedThreadSettings(patch, outcomes[1]);
          confirmedModel = confirmed.model;
          confirmedServiceTier = confirmed.serviceTier;
          session.confirmedModel = confirmedModel;
          session.confirmedServiceTier = confirmedServiceTier;
        } catch (error) {
          const updateFence = fence();
          if (updateFence) return updateFence;
          if (error instanceof CodexAppServerRpcError) {
            throw codexFastModeError(
              'PROVIDER_FAILURE',
              'Codex rejected the Fast mode update. The previous setting remains active.',
              true,
              {
                operation: 'thread/settings/update',
                requestedModel: patch.model,
                requestedServiceTier: patch.serviceTier,
              },
            );
          }
          ambiguousFailure = this.#ambiguousFailure(error, patch);
        } finally {
          confirmation.dispose();
        }
      }

      if (!ambiguousFailure) {
        const completionFence = fence();
        if (completionFence) return completionFence;
        if (
          confirmedModel !== patch.model
          || confirmedServiceTier !== patch.serviceTier
        ) {
          throw new Error('Codex thread settings confirmation invariant failed');
        }
        session.prioritySupportModel = patch.serviceTier === 'priority'
          ? patch.model
          : null;
        session.permissionMode = patch.permissionMode;
        this.options.logger.debug('Codex thread settings confirmed', {
          chatId: session.chatId,
          threadId: session.threadId,
          operation: 'thread/settings/update',
          requestedModel: patch.model,
          confirmedModel,
          requestedServiceTier: patch.serviceTier,
          confirmedServiceTier,
          prioritySupportModel: session.prioritySupportModel,
        });
        return {
          kind: 'applied',
          confirmedModel,
          confirmedServiceTier,
        };
      }
    } finally {
      session.activeDeliveryReservations -= 1;
      if (!ambiguousFailure) this.options.flushPendingFinish(session);
    }

    await this.#retireAmbiguousSession(session, ambiguousFailure);
    return this.options.sessions.has(agentSessionId)
      ? { kind: 'retry-current-session' }
      : { kind: 'session-absent' };
  }

  async #assertModelAdvertisesPriority(
    client: CodexAppServerClient,
    model: string,
  ): Promise<void> {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < this.#modelListMaxPages; page += 1) {
      const response: ModelListResponse = await client.listModels({
        cursor,
        limit: null,
        includeHidden: true,
      });
      const match = response.data.find((entry) => entry.id === model || entry.model === model);
      if (match?.serviceTiers.some((tier) => tier.id === 'priority')) return;
      if (match || response.nextCursor === null) {
        throw codexFastModeError(
          'INVALID_SETTINGS',
          `Codex Fast mode is unavailable for ${model}. Choose Off or a supported model.`,
          false,
          { operation: 'model/list', requestedModel: model },
        );
      }
      if (cursors.has(response.nextCursor)) {
        throw new CodexProtocolParseError('Codex model/list returned a cursor cycle');
      }
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new CodexProtocolParseError('Codex model/list exceeded the pagination limit');
  }

  #classifyModelListFailure(error: unknown, model: string): AgentIntegrationError {
    if (error instanceof AgentIntegrationError) return error;
    if (error instanceof CodexSettingsTimeoutError) {
      return codexFastModeError(
        'TIMEOUT',
        'Codex model support could not be confirmed in time. Try again or choose Off.',
        true,
        { operation: 'model/list', requestedModel: model },
      );
    }
    if (error instanceof CodexProtocolParseError) {
      return codexFastModeError(
        'INVALID_SETTINGS',
        'Codex model support could not be confirmed. Choose Off or a supported model.',
        false,
        { operation: 'model/list', requestedModel: model },
      );
    }
    return codexFastModeError(
      'UNAVAILABLE',
      'Codex model support is temporarily unavailable. Try again or choose Off.',
      true,
      { operation: 'model/list', requestedModel: model },
    );
  }

  #assertAppliedThreadSettings(
    requested: CodexSessionSettingsPatch,
    applied: ThreadSettingsUpdatedNotification['threadSettings'],
  ): { readonly model: string; readonly serviceTier: CodexServiceTier } {
    if (
      applied.model !== requested.model
      || applied.serviceTier !== requested.serviceTier
    ) {
      throw new Error('Codex reported different thread settings than requested');
    }
    return { model: applied.model, serviceTier: requested.serviceTier };
  }

  #ambiguousFailure(
    error: unknown,
    patch: CodexSessionSettingsPatch,
  ): AgentIntegrationError {
    const timedOut = error instanceof CodexSettingsTimeoutError;
    return codexFastModeError(
      timedOut ? 'TIMEOUT' : 'PROVIDER_FAILURE',
      timedOut
        ? 'Codex did not confirm the Fast mode update in time.'
        : 'Codex could not confirm the Fast mode update.',
      true,
      {
        operation: 'thread/settings/update',
        requestedModel: patch.model,
        requestedServiceTier: patch.serviceTier,
      },
    );
  }

  async #retireAmbiguousSession(
    session: RunningCodexSession,
    error: AgentIntegrationError,
  ): Promise<void> {
    const isCurrent = this.options.sessions.get(session.threadId) === session;
    cancelThreadSettingsConfirmation(
      session,
      'Codex session retired after an unconfirmed settings update',
    );
    cancelTurnStartWaiters(session, 'Codex session retired after an unconfirmed settings update');
    if (isCurrent) this.options.sessions.delete(session.threadId);
    if (this.options.sources.get(session.client) === session) {
      this.options.sources.delete(session.client);
    }
    session.status = 'failed';
    session.pendingFinish = null;
    session.pendingFinishOperation = null;
    session.turnRoutes.clear();
    session.nextTurnOperation = null;
    session.goalOperation = null;
    cancelPendingApprovals(
      this.options.logger,
      this.options.pendingApprovals,
      session.client,
      'cancelled',
    );
    void session.cleanupAttachments?.();
    if (isCurrent) {
      this.options.publishFailed(
        session,
        error.message,
        session.lastTurnOperation ?? session.sourceOperation,
      );
    }
    this.options.logger.warn('Retired Codex session after unconfirmed thread settings', {
      chatId: session.chatId,
      threadId: session.threadId,
      code: error.code,
    });
    await this.options.shutdownClient(session.client);
  }

  async #withTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutError: Error): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(timeoutError), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
