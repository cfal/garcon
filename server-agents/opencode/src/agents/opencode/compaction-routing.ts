import type { AgentLogger } from '@garcon/server-agent-interface';
import { isRecord } from '@garcon/common/json';
import { CompactionMessage } from '@garcon/common/chat-types';
import type {
  OpenCodeOperationRoute,
  OpenCodeOperationRoutes,
} from './operation-routes.js';
import { isOpenCodeCompactionAssistant, openCodeAssistantTerminal } from './sse-events.js';
import type { SSEEvent } from './sse-events.js';
import type { OpenCodeSession } from './turn-events.js';

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
      const part = event.properties?.part;
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

export interface OpenCodeManualCompactionBoundary {
  readonly row: CompactionMessage;
  // The successful summary assistant's id anchors the boundary so point-fork
  // boundaries match across live and reloaded transcripts.
  readonly summaryMessageId: string;
}

// The single boundary row a manual compaction turn publishes: only a summary
// assistant that finished successfully replaced prior context; a failed or
// aborted summary leaves the boundary unmarked. Summary text and control parts
// stay internal to the native session.
export function manualCompactionBoundaryRow(event: SSEEvent): OpenCodeManualCompactionBoundary | null {
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
    row: new CompactionMessage(new Date(completed).toISOString(), 'manual', ''),
    summaryMessageId: terminal.messageId,
  };
}
