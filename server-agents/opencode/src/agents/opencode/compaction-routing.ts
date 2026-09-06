import type { AgentLogger } from '@garcon/server-agent-interface';
import { isRecord } from '@garcon/common/json';
import { CompactionMessage, type CompactionTrigger } from '@garcon/common/chat-types';
import type {
  OpenCodeOperationRoute,
  OpenCodeOperationRoutes,
} from './operation-routes.js';
import { isOpenCodeCompactionAssistant, openCodeAssistantTerminal } from './sse-events.js';
import type { SSEEvent } from './sse-events.js';
import type { OpenCodeSession, OpenCodeTurnContext } from './turn-events.js';

type OpenCodeCompactionPartDropCode =
  | 'COMPACTION_PART_NO_SESSION'
  | 'COMPACTION_PART_SESSION_NOT_RUNNING'
  | 'COMPACTION_PART_BEFORE_PROMPT'
  | 'COMPACTION_PART_ROUTE_RETIRED'
  | 'COMPACTION_PART_INVALID_IDENTIFIERS'
  | 'COMPACTION_PART_IDENTITY_COLLISION';

interface OpenCodeCompactionPartRouteInput {
  readonly event: SSEEvent;
  readonly logger: AgentLogger;
  readonly operationRoutes: OpenCodeOperationRoutes;
  readonly session: OpenCodeSession | undefined;
  readonly sessionId: string;
}

export function adoptOpenCodeCompactionPartRoute(
  input: OpenCodeCompactionPartRouteInput,
): OpenCodeOperationRoute | null {
  const { event, logger, operationRoutes, session, sessionId } = input;
  if (!session) return dropCompactionPart(logger, 'COMPACTION_PART_NO_SESSION', sessionId, event);
  if (session.status !== 'running') {
    return dropCompactionPart(
      logger,
      'COMPACTION_PART_SESSION_NOT_RUNNING',
      sessionId,
      event,
    );
  }

  const part = event.properties?.part;
  const messageId = typeof part?.messageID === 'string' ? part.messageID : '';
  // A manual compaction control part is the compaction turn's own source message:
  // adopting it supplies the provider identity the summarize route never returns.
  if (part && (part as Record<string, unknown>).auto !== true && session.turn.compaction) {
    if (session.turn.providerMessageId !== null) {
      return dropCompactionPart(logger, 'COMPACTION_PART_BEFORE_PROMPT', sessionId, event);
    }
    const manualAdoption = operationRoutes.adoptCompactionPart(session.turn, event);
    if (manualAdoption.kind !== 'adopted') {
      return dropCompactionPart(
        logger,
        manualAdoption.kind === 'route-retired'
          ? 'COMPACTION_PART_ROUTE_RETIRED'
          : manualAdoption.kind === 'invalid-identifiers'
            ? 'COMPACTION_PART_INVALID_IDENTIFIERS'
            : 'COMPACTION_PART_IDENTITY_COLLISION',
        sessionId,
        event,
      );
    }
    session.turn.providerMessageId = messageId;
    logger.debug('Adopted an OpenCode manual compaction source', {
      agentSessionId: sessionId,
      messageId,
      partId: typeof part.id === 'string' ? part.id : null,
    });
    return manualAdoption.route;
  }

  if (session.turn.providerMessageId === null) {
    return dropCompactionPart(logger, 'COMPACTION_PART_BEFORE_PROMPT', sessionId, event);
  }

  const adoption = operationRoutes.adoptCompactionPart(session.turn, event);
  switch (adoption.kind) {
    case 'adopted': {
      if (isRecord(part) && part.auto === true) {
        session.turn.automaticCompactionMessageIds.add(messageId);
      }
      logger.debug('Adopted an OpenCode compaction part', {
        agentSessionId: sessionId,
        partId: typeof part?.id === 'string' ? part.id : null,
        messageId: typeof part?.messageID === 'string' ? part.messageID : null,
      });
      return adoption.route;
    }
    case 'route-retired':
      return dropCompactionPart(logger, 'COMPACTION_PART_ROUTE_RETIRED', sessionId, event);
    case 'invalid-identifiers':
      return dropCompactionPart(
        logger,
        'COMPACTION_PART_INVALID_IDENTIFIERS',
        sessionId,
        event,
      );
    case 'identity-collision':
      return dropCompactionPart(
        logger,
        'COMPACTION_PART_IDENTITY_COLLISION',
        sessionId,
        event,
      );
  }
}

function dropCompactionPart(
  logger: AgentLogger,
  code: OpenCodeCompactionPartDropCode,
  sessionId: string,
  event: SSEEvent,
): null {
  const part = event.properties?.part;
  logger.warn('Dropping an OpenCode compaction part', {
    code,
    agentSessionId: sessionId,
    eventId: event.id ?? null,
    partId: typeof part?.id === 'string' ? part.id : null,
    messageId: typeof part?.messageID === 'string' ? part.messageID : null,
  });
  return null;
}

export interface OpenCodeCompactionBoundary {
  readonly row: CompactionMessage;
  // Manual boundaries retain their reload-stable point-fork anchor. Automatic
  // boundaries use the same live anchor but are intentionally absent after Reload.
  readonly summaryMessageId: string;
}

// Classifies every internal compaction event so control parts, summary parts,
// and the successful boundary all stay out of the ordinary message converter.
export function compactionEventTrigger(
  event: SSEEvent,
  turn: OpenCodeTurnContext,
): CompactionTrigger | null {
  if (turn.compaction) return 'manual';
  const messageId = event.properties?.info?.id
    ?? event.properties?.part?.messageID
    ?? event.properties?.messageID;
  return typeof messageId === 'string' && turn.automaticCompactionMessageIds.has(messageId)
    ? 'auto'
    : null;
}

// Only a summary assistant that finished successfully replaced prior context.
// Summary text and control parts stay internal to the native session.
export function compactionBoundaryRow(
  event: SSEEvent,
  trigger: CompactionTrigger,
): OpenCodeCompactionBoundary | null {
  if (event.type !== 'message.updated') return null;
  const info = event.properties?.info;
  if (!isRecord(info) || !isOpenCodeCompactionAssistant(info)) return null;
  const terminal = openCodeAssistantTerminal(event);
  if (!terminal || terminal.outcome !== 'finished') return null;
  const completed = isRecord(info.time) && typeof info.time.completed === 'number'
    ? info.time.completed
    : null;
  if (completed === null) return null;
  return {
    row: new CompactionMessage(new Date(completed).toISOString(), trigger, ''),
    summaryMessageId: terminal.messageId,
  };
}
