import type { AgentLogger } from '@garcon/server-agent-interface';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';
import {
  claudeBackgroundTaskCount,
  claudeProviderSessionState,
  type ClaudeCLIMessage,
  type ClaudeProviderSessionState,
  type ClaudeTurnState,
} from './cli-protocol.js';
import type { ClaudeTurnSteeringState } from './steering.js';

interface ClaudeProviderStateTurn {
  readonly protocol: ClaudeTurnState;
  readonly steering: ClaudeTurnSteeringState;
  readonly operation: Pick<AgentRuntimeOperation, 'runId'>;
}

export interface ClaudeProviderStateSession {
  readonly id: string;
  readonly chatId: string;
  providerState: ClaudeProviderSessionState;
  backgroundTaskCount: number;
  unownedProviderActivity: boolean;
  lastActivityAt: number;
  readonly process: { readonly pid?: number } | null;
  readonly activeTurn: ClaudeProviderStateTurn | null;
}

export interface ClaudeProviderStateHandlers {
  readonly logger: AgentLogger;
  readonly finish: () => void;
  readonly fail: (message: string) => void;
  readonly retire: () => void;
  readonly steeringIdleFenceTimeoutMs: number;
}

export function flushDeferredClaudeProviderIdle(
  session: ClaudeProviderStateSession,
  handlers: ClaudeProviderStateHandlers,
): void {
  const activeTurn = session.activeTurn;
  if (
    session.providerState !== 'idle'
    || !activeTurn?.steering.hasDeferredIdle
  ) return;
  settleClaudeProviderIdle(session, handlers);
}

function settleClaudeProviderIdle(
  session: ClaudeProviderStateSession,
  handlers: ClaudeProviderStateHandlers,
): void {
  const activeTurn = session.activeTurn;
  if (!activeTurn?.protocol.inputStarted) return;

  const protocol = activeTurn.protocol;
  const steering = activeTurn.steering;
  steering.rememberProviderIdle();
  const details = {
    chatId: session.chatId,
    runId: activeTurn.operation.runId,
    sessionId: session.id.slice(0, 8),
    processId: session.process?.pid ?? null,
    inputId: protocol.inputUuid.slice(0, 8),
    outputMessages: protocol.outputMessageCount,
    resultSeen: protocol.hasAcceptedResult,
    backgroundTaskCount: session.backgroundTaskCount,
    backgroundContinuationPending: protocol.backgroundContinuationPending,
    steeringReservations: steering.reservationCount,
    submittedSteers: steering.submittedCount,
    activeSteers: steering.activeCount,
  };

  if (steering.blocksIdleSettlement) {
    handlers.logger.debug('Claude CLI provider idle deferred for steering work', details);
    steering.deferIdle(() => {
      if (
        session.activeTurn !== activeTurn
        || session.providerState !== 'idle'
        || !steering.blocksIdleSettlement
      ) return;
      handlers.logger.warn('Claude CLI remained idle across accepted steering work', details);
      handlers.fail('Claude CLI did not make progress on accepted steering input.');
      handlers.retire();
    }, handlers.steeringIdleFenceTimeoutMs);
    return;
  }

  if (!protocol.hasAcceptedResult) {
    handlers.logger.warn(
      'Claude CLI became idle before producing a result for the submitted input',
      details,
    );
    handlers.fail(
      'Claude CLI became idle before the submitted message produced a terminal result.',
    );
    handlers.retire();
    return;
  }
  // Provider idle, not an empty task snapshot or a result, proves no continuation is owed.
  // Outstanding tasks also guard CLIs that report idle at each turn boundary.
  // https://github.com/anthropics/claude-agent-sdk-python/blob/f7529348747235da34af3ed202251228ff31db08/src/claude_agent_sdk/_internal/query.py#L870-L907
  if (
    protocol.backgroundContinuationPending
    && !protocol.abortRequested
    && session.backgroundTaskCount > 0
  ) {
    handlers.logger.info(
      'Claude CLI became idle while a background continuation remains pending',
      details,
    );
    return;
  }
  const retireAfterSettlement =
    protocol.backgroundContinuationPending && protocol.abortRequested;
  if (retireAfterSettlement) session.backgroundTaskCount = 0;

  const failure = protocol.settlementFailureMessage()
    ?? steering.settlementFailureMessage;
  if (failure) {
    handlers.logger.warn('Claude CLI run settled with an error', details);
    handlers.fail(failure);
    if (retireAfterSettlement) handlers.retire();
    return;
  }
  if (protocol.cleanAbortResultSeen) {
    handlers.logger.info('Claude CLI run stopped after an interrupt', details);
  } else {
    handlers.logger.info('Claude CLI run settled at provider idle', details);
  }
  handlers.finish();
  if (retireAfterSettlement) handlers.retire();
}

export function handleClaudeProviderLifecycleMessage(
  message: ClaudeCLIMessage,
  session: ClaudeProviderStateSession,
  handlers: ClaudeProviderStateHandlers,
): boolean {
  const backgroundTaskCount = claudeBackgroundTaskCount(message);
  if (backgroundTaskCount !== null) {
    const previous = session.backgroundTaskCount;
    session.backgroundTaskCount = backgroundTaskCount;
    const activeTurn = session.activeTurn;
    if (activeTurn?.protocol.inputStarted) {
      activeTurn.protocol.observeBackgroundTaskCount(backgroundTaskCount);
    }
    handlers.logger.debug('Claude CLI background tasks changed', {
      chatId: session.chatId,
      runId: activeTurn?.operation.runId ?? null,
      sessionId: session.id.slice(0, 8),
      processId: session.process?.pid ?? null,
      previousCount: previous,
      nextCount: backgroundTaskCount,
    });
    return true;
  }

  const next = claudeProviderSessionState(message);
  if (!next) return false;

  const previous = session.providerState;
  session.providerState = next;
  session.lastActivityAt = Date.now();
  const activeTurn = session.activeTurn;
  handlers.logger.debug('Claude CLI session state changed', {
    chatId: session.chatId,
    runId: activeTurn?.operation.runId ?? null,
    sessionId: session.id.slice(0, 8),
    processId: session.process?.pid ?? null,
    previous,
    next,
    inputStarted: activeTurn?.protocol.inputStarted ?? false,
    resultSeen: activeTurn?.protocol.hasAcceptedResult ?? false,
    backgroundTaskCount: session.backgroundTaskCount,
  });
  if (!activeTurn) {
    if (
      !session.unownedProviderActivity
      && (next === 'running' || next === 'requires_action')
    ) {
      session.unownedProviderActivity = true;
      handlers.logger.warn('Claude CLI emitted provider activity without an active Garcon turn', {
        chatId: session.chatId,
        sessionId: session.id.slice(0, 8),
        processId: session.process?.pid ?? null,
        previous,
        next,
        backgroundTaskCount: session.backgroundTaskCount,
      });
    } else if (next === 'idle' && session.unownedProviderActivity) {
      session.unownedProviderActivity = false;
      handlers.retire();
    }
    return true;
  }
  if (next !== 'idle' || !activeTurn.protocol.inputStarted) return true;
  settleClaudeProviderIdle(session, handlers);
  return true;
}
