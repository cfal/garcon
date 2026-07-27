import type { AgentLogger } from '@garcon/server-agent-interface';
import {
  claudeBackgroundTaskCount,
  claudeProviderSessionState,
  type ClaudeCLIMessage,
  type ClaudeProviderSessionState,
  type ClaudeTurnState,
} from './cli-protocol.js';

interface ClaudeProviderStateTurn {
  readonly protocol: ClaudeTurnState;
  readonly eventMetadata: { readonly turnId?: string };
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

interface ClaudeProviderStateHandlers {
  readonly logger: AgentLogger;
  readonly finish: () => void;
  readonly fail: (message: string) => void;
  readonly retire: () => void;
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
      turnId: activeTurn?.eventMetadata.turnId ?? null,
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
    turnId: activeTurn?.eventMetadata.turnId ?? null,
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

  const protocol = activeTurn.protocol;
  const details = {
    chatId: session.chatId,
    turnId: activeTurn.eventMetadata.turnId ?? null,
    sessionId: session.id.slice(0, 8),
    processId: session.process?.pid ?? null,
    inputId: protocol.inputUuid.slice(0, 8),
    outputMessages: protocol.outputMessageCount,
    resultSeen: protocol.hasAcceptedResult,
    backgroundTaskCount: session.backgroundTaskCount,
    backgroundContinuationPending: protocol.backgroundContinuationPending,
  };
  if (!protocol.hasAcceptedResult) {
    handlers.logger.warn(
      'Claude CLI became idle before producing a result for the submitted input',
      details,
    );
    handlers.fail(
      'Claude CLI became idle before the submitted message produced a terminal result.',
    );
    handlers.retire();
    return true;
  }
  if (protocol.backgroundContinuationPending && !protocol.abortRequested) {
    handlers.logger.info(
      'Claude CLI became idle while a background continuation remains pending',
      details,
    );
    return true;
  }

  const failure = protocol.settlementFailureMessage();
  if (failure) {
    handlers.logger.warn('Claude CLI run settled with an error', details);
    handlers.fail(failure);
    return true;
  }
  if (protocol.cleanAbortResultSeen) {
    handlers.logger.info('Claude CLI run stopped after an interrupt', details);
  } else {
    handlers.logger.info('Claude CLI run settled at provider idle', details);
  }
  handlers.finish();
  return true;
}
