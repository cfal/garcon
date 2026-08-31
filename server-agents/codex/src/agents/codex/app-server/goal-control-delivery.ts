import type { CodexResumeRequest } from '../runtime-types.js';
import {
  buildTurnStartParams,
  buildUserInput,
  goalObjectiveWithAttachmentPaths,
  writeAttachmentsToTempFiles,
} from './request-builders.js';
import type { CodexOperation } from './operation-routes.js';
import {
  adoptTurn,
  canApplyTurnAttempt,
  generationAcrossTurnBoundary,
  TurnStartWaitCancelledError,
  waitForDifferentTurnStart,
  waitForTurnStart,
  type RunningCodexSession,
} from './runtime-session-state.js';
import {
  actualTurnIdFromSteerMismatch,
  isActiveTurnNotSteerableError,
  isNoActiveTurnError,
} from './steering.js';
import {
  GOAL_TURN_START_TIMEOUT_MS,
  hasTerminalPendingFinish,
  isActiveTurnConflictError,
  MAX_GOAL_CONTROL_DELIVERY_TRANSITIONS,
} from './runtime-support.js';

interface GoalControlDeliveryOptions {
  readonly sessions: ReadonlyMap<string, RunningCodexSession>;
  readonly session: RunningCodexSession;
  readonly request: CodexResumeRequest;
  readonly operation: CodexOperation;
  handleGoalCommand(): Promise<void>;
}

function retainAttachmentCleanup(
  session: RunningCodexSession,
  cleanup: () => Promise<void>,
): void {
  const previous = session.cleanupAttachments;
  session.cleanupAttachments = previous
    ? async () => { await Promise.all([previous(), cleanup()]); }
    : cleanup;
}

export async function deliverReservedGoalControl(
  options: GoalControlDeliveryOptions,
): Promise<void> {
  const { sessions, session, request, operation } = options;
  if (request.codexGoalCommand) {
    await options.handleGoalCommand();
    return;
  }

  const attachments = await writeAttachmentsToTempFiles(request.images);
  retainAttachmentCleanup(session, attachments.cleanup);
  const command = goalObjectiveWithAttachmentPaths(request.command, [], attachments.filePaths);
  const input = buildUserInput(command, attachments.imagePaths);
  const startParams = buildTurnStartParams({
    threadId: session.threadId,
    command,
    imagePaths: attachments.imagePaths,
    model: request.model,
    serviceTier: request.serviceTier,
    projectPath: request.projectPath,
    permissionMode: request.permissionMode,
    thinkingMode: request.thinkingMode,
    clientMessageId: request.clientMessageId,
  });
  let turnId = session.activeTurnId;
  let transitions = 0;

  if (!turnId && session.goal?.status === 'active') {
    turnId = await waitForTurnStart(sessions, session, GOAL_TURN_START_TIMEOUT_MS);
  }
  let turnAttemptGeneration = session.turnAttemptGeneration;

  while (transitions < MAX_GOAL_CONTROL_DELIVERY_TRANSITIONS) {
    if (session.turnAttemptGeneration !== turnAttemptGeneration) {
      throw new TurnStartWaitCancelledError('Codex turn changed before goal control delivery');
    }
    if (sessions.get(session.threadId) !== session || hasTerminalPendingFinish(session)) {
      throw new TurnStartWaitCancelledError('Codex session ended before goal control delivery');
    }
    if (!turnId && session.activeTurnId) turnId = session.activeTurnId;

    if (!turnId) {
      const previousTurnId = session.activeTurnId;
      try {
        session.nextTurnOperation = operation;
        const turn = await session.client.startTurn(startParams);
        if (!canApplyTurnAttempt(sessions, session, turnAttemptGeneration)) return;
        adoptTurn(session, turn.turn.id, operation);
        return;
      } catch (error) {
        const isTurnTransition = isActiveTurnConflictError(error)
          || isActiveTurnNotSteerableError(error);
        if (session.turnAttemptGeneration !== turnAttemptGeneration) {
          const nextGeneration = isTurnTransition
            ? generationAcrossTurnBoundary(session, turnAttemptGeneration)
            : null;
          if (nextGeneration === null) throw error;
          turnAttemptGeneration = nextGeneration;
        }
        if (!canApplyTurnAttempt(sessions, session, turnAttemptGeneration)) throw error;
        if (!isTurnTransition) throw error;
        turnId = await waitForDifferentTurnStart(
          sessions,
          session,
          previousTurnId,
          GOAL_TURN_START_TIMEOUT_MS,
        );
        const nextGeneration = generationAcrossTurnBoundary(session, turnAttemptGeneration);
        if (nextGeneration === null) throw error;
        turnAttemptGeneration = nextGeneration;
        transitions += 1;
        continue;
      }
    }

    try {
      await session.client.steerTurn({
        threadId: session.threadId,
        expectedTurnId: turnId,
        input,
        ...(request.clientMessageId ? { clientUserMessageId: request.clientMessageId } : {}),
      });
      if (!canApplyTurnAttempt(sessions, session, turnAttemptGeneration)) return;
      return;
    } catch (error) {
      const isNonSteerable = isActiveTurnNotSteerableError(error);
      const actualTurnId = actualTurnIdFromSteerMismatch(error);
      const noActiveTurn = isNoActiveTurnError(error);
      const isTurnTransition = isNonSteerable || actualTurnId !== null || noActiveTurn;
      if (session.turnAttemptGeneration !== turnAttemptGeneration) {
        const nextGeneration = isTurnTransition
          ? generationAcrossTurnBoundary(session, turnAttemptGeneration)
          : null;
        if (nextGeneration === null) throw error;
        turnAttemptGeneration = nextGeneration;
      }
      if (!canApplyTurnAttempt(sessions, session, turnAttemptGeneration)) throw error;
      if (actualTurnId && actualTurnId !== turnId) {
        adoptTurn(session, actualTurnId, operation);
        turnId = actualTurnId;
        transitions += 1;
        continue;
      }
      if (actualTurnId) throw error;
      if (isNonSteerable) {
        turnId = await waitForDifferentTurnStart(
          sessions,
          session,
          turnId,
          GOAL_TURN_START_TIMEOUT_MS,
        );
        const nextGeneration = generationAcrossTurnBoundary(session, turnAttemptGeneration);
        if (nextGeneration === null) throw error;
        turnAttemptGeneration = nextGeneration;
        transitions += 1;
        continue;
      }
      if (noActiveTurn) {
        if (session.activeTurnId === turnId) session.activeTurnId = null;
        turnId = null;
        transitions += 1;
        continue;
      }
      throw error;
    }
  }
  throw new Error('Codex goal control delivery exceeded the turn transition limit');
}
