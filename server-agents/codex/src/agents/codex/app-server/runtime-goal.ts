import { AssistantMessage, ErrorMessage } from '@garcon/common/chat-types';
import type {
  AgentGoalControlHandoff,
  AgentLogger,
} from '@garcon/server-agent-interface';
import type { CodexGoalCommand } from '../goal-command.js';
import type {
  CodexResumeRequest,
  CodexStartRequest,
} from '../runtime-types.js';
import type { CodexAppServerClient } from './client.js';
import {
  editedGoalStatus,
  formatGoalStatusMessage,
  formatGoalUpdatedMessage,
  goalStatusLabel,
} from './goal-display.js';
import { publishRows, type CodexOperation } from './operation-routes.js';
import type {
  CodexThreadGoal,
  ThreadGoalClearedNotification,
  ThreadGoalSetResponse,
  ThreadGoalUpdatedNotification,
} from './protocol.js';
import {
  buildTurnStartParams,
  buildUserInput,
  goalObjectiveWithAttachmentPaths,
  writeAttachmentsToTempFiles,
} from './request-builders.js';
import {
  adoptTurn,
  sessionForClientThread,
  TurnStartWaitCancelledError,
  waitForDifferentTurnStart,
  waitForTurnStart,
  type FinishSessionOptions,
  type GoalCommandOptions,
  type RunningCodexSession,
} from './runtime-session-state.js';
import {
  GOAL_TURN_START_TIMEOUT_MS,
  hasActiveGoalContinuation,
  hasTerminalPendingFinish,
  humanizeCodexAppServerError,
  isActiveTurnConflictError,
  isTerminalSessionStatus,
  MAX_GOAL_CONTROL_DELIVERY_TRANSITIONS,
} from './runtime-support.js';
import {
  actualTurnIdFromSteerMismatch,
  isActiveTurnNotSteerableError,
  isNoActiveTurnError,
} from './steering.ts';

// Session-lifecycle operations the goal coordinator drives but the runtime
// owns. The sessions map is shared by reference; the runtime only mutates it
// in place, so identity checks stay valid.
export interface RuntimeGoalPort {
  sessions: ReadonlyMap<string, RunningCodexSession>;
  logger: AgentLogger;
  finishSession(session: RunningCodexSession, opts: FinishSessionOptions, operation: CodexOperation | null): void;
  flushPendingFinish(session: RunningCodexSession): void;
  canApplyTurnAttempt(session: RunningCodexSession, generation: number): boolean;
  generationAcrossTurnBoundary(session: RunningCodexSession, generation: number): number | null;
}

// Owns Codex goal lifecycle orchestration: /goal command handling, queued
// goal-control delivery across turn transitions, and goal notifications.
export class RuntimeGoalCoordinator {
  #port: RuntimeGoalPort;

  constructor(port: RuntimeGoalPort) {
    this.#port = port;
  }

  async handleCommand(
    client: CodexAppServerClient,
    session: RunningCodexSession,
    command: CodexGoalCommand,
    request: CodexStartRequest | CodexResumeRequest,
    operation: CodexOperation,
    options: GoalCommandOptions,
  ): Promise<void> {
    const {
      keepSession,
      goalSynchronized = false,
      propagateDeliveryFailure = false,
    } = options;
    try {
      switch (command.kind) {
        case 'set':
        case 'replace': {
          const current = goalSynchronized
            ? { goal: session.goal }
            : await client.getThreadGoal(session.threadId);
          if (command.kind === 'set' && current.goal && current.goal.status !== 'complete') {
            publishRows(this.#port.logger, session.chatId, [new ErrorMessage(
              new Date().toISOString(),
              `An unfinished Codex goal is already ${goalStatusLabel(current.goal.status)}: ${current.goal.objective}\nUse /goal replace <objective> to replace it explicitly, or /goal clear first.`,
            )], operation);
            if (!keepSession) this.#port.finishSession(session, {}, operation);
            return;
          }
          session.goalOperation = operation;
          session.nextTurnOperation = operation;
          const response = await session.goalAttachments.set(
            client,
            command.objective,
            request.images,
            (objective) => current.goal
              ? this.#replaceThreadGoal(client, session, current.goal, objective)
              : this.#setNewThreadGoal(client, session, objective),
          );
          session.goal = response.goal;
          await waitForTurnStart(this.#port.sessions, session, GOAL_TURN_START_TIMEOUT_MS);
          return;
        }
        case 'status': {
          const response = goalSynchronized
            ? { goal: session.goal }
            : await client.getThreadGoal(session.threadId);
          session.goal = response.goal;
          if (response.goal?.status === 'active') session.managesGoalLifecycle = true;
          publishRows(this.#port.logger, session.chatId, [
            new AssistantMessage(new Date().toISOString(), formatGoalStatusMessage(response.goal)),
          ], operation);
          if (!keepSession && !hasActiveGoalContinuation(session)) this.#port.finishSession(session, {}, operation);
          return;
        }
        case 'clear': {
          const response = await session.goalAttachments.clear(() => this.#clearThreadGoal(client, session));
          if (response.cleared) session.goal = null;
          const message = response.cleared ? 'Codex goal cleared.' : 'No Codex goal was set.';
          publishRows(this.#port.logger, session.chatId, [new AssistantMessage(new Date().toISOString(), message)], operation);
          if (!keepSession || !session.activeTurnId) this.#port.finishSession(session, {}, operation);
          return;
        }
        case 'pause': {
          const response = await client.setThreadGoalStatus(session.threadId, 'paused');
          session.goal = response.goal;
          publishRows(this.#port.logger, session.chatId, [
            new AssistantMessage(new Date().toISOString(), formatGoalUpdatedMessage('paused', response.goal)),
          ], operation);
          if (!keepSession || !session.activeTurnId) this.#port.finishSession(session, {}, operation);
          return;
        }
        case 'resume': {
          const previouslyManaged = session.managesGoalLifecycle;
          const turnAttemptGeneration = session.turnAttemptGeneration;
          session.goalOperation = operation;
          session.nextTurnOperation = operation;
          const response = await client.setThreadGoalStatus(session.threadId, 'active');
          if (!this.#port.canApplyTurnAttempt(session, turnAttemptGeneration)) return;
          session.goal = response.goal;
          if (response.goal.status === 'active') {
            session.managesGoalLifecycle = true;
            await waitForTurnStart(this.#port.sessions, session, GOAL_TURN_START_TIMEOUT_MS);
          } else {
            session.managesGoalLifecycle = previouslyManaged;
            publishRows(this.#port.logger, session.chatId, [
              new AssistantMessage(new Date().toISOString(), formatGoalUpdatedMessage('updated', response.goal)),
            ], operation);
            if (!hasActiveGoalContinuation(session)) this.#port.finishSession(session, {}, operation);
          }
          return;
        }
        case 'edit': {
          if (!command.objective) {
            publishRows(this.#port.logger, session.chatId, [new ErrorMessage(
              new Date().toISOString(),
              'Usage: /goal edit <objective>',
            )], operation);
            if (!keepSession) this.#port.finishSession(session, {}, operation);
            return;
          }
          const editedObjective = command.objective;
          const current = goalSynchronized
            ? session.goal
            : (await client.getThreadGoal(session.threadId)).goal;
          if (!current) {
            publishRows(this.#port.logger, session.chatId, [new ErrorMessage(
              new Date().toISOString(),
              'No Codex goal is set. Start one with /goal <objective>.',
            )], operation);
            if (!keepSession) this.#port.finishSession(session, {}, operation);
            return;
          }
          const status = editedGoalStatus(current.status);
          const previouslyManaged = session.managesGoalLifecycle;
          if (status === 'active') {
            session.goalOperation = operation;
            session.nextTurnOperation = operation;
          }
          const response = await session.goalAttachments.set(
            client,
            editedObjective,
            request.images,
            async (objective) => {
              if (status === 'active') session.managesGoalLifecycle = true;
              return client.setThreadGoal(session.threadId, {
                objective,
                status,
                tokenBudget: current.tokenBudget,
              });
            },
          );
          session.goal = response.goal;
          if (response.goal.status === 'active') {
            await waitForTurnStart(this.#port.sessions, session, GOAL_TURN_START_TIMEOUT_MS);
          } else {
            session.managesGoalLifecycle = previouslyManaged;
            publishRows(this.#port.logger, session.chatId, [
              new AssistantMessage(new Date().toISOString(), formatGoalUpdatedMessage('updated', response.goal)),
            ], operation);
            if (!keepSession || !session.activeTurnId) this.#port.finishSession(session, {}, operation);
          }
          return;
        }
        case 'unsupported':
          publishRows(this.#port.logger, session.chatId, [
            new ErrorMessage(
              new Date().toISOString(),
              `Unsupported Codex goal command: /goal ${command.subcommand}. Use /goal <objective>, /goal replace <objective>, /goal edit <objective>, /goal pause, /goal resume, or /goal clear.`,
            ),
          ], operation);
          if (!keepSession) this.#port.finishSession(session, {}, operation);
          return;
      }
    } catch (error) {
      if (error instanceof TurnStartWaitCancelledError) {
        if (propagateDeliveryFailure) throw error;
        return;
      }
      publishRows(this.#port.logger, session.chatId, [new ErrorMessage(new Date().toISOString(), humanizeCodexAppServerError(error))], operation);
      if (!hasActiveGoalContinuation(session)) {
        this.#port.finishSession(session, {}, operation);
      }
      if (propagateDeliveryFailure) throw error;
      return;
    }
  }

  async submitGoalControl(
    request: CodexResumeRequest,
    beforeDelivery: (handoff: AgentGoalControlHandoff) => Promise<void> = async (handoff) => {
      handoff.validate();
      handoff.commit();
    },
  ): Promise<boolean> {
    const session = this.#port.sessions.get(request.agentSessionId);
    if (!session || session.status === 'completed' || session.status === 'failed' || session.status === 'aborted') {
      return false;
    }
    if (!session.managesGoalLifecycle) return false;
    const operation = request.operation;
    const delivery = session.activeInputChain.then(async () => {
      if (this.#port.sessions.get(request.agentSessionId) !== session) return false;
      if (
        !session.managesGoalLifecycle
        || session.status === 'failed'
        || session.status === 'aborted'
        || session.status === 'completed'
        || hasTerminalPendingFinish(session)
      ) return false;
      session.activeDeliveryReservations += 1;
      try {
        const validate = () => {
          if (
            this.#port.sessions.get(request.agentSessionId) !== session
            || hasTerminalPendingFinish(session)
            || isTerminalSessionStatus(session.status)
          ) {
            throw new Error(session.pendingFinish?.failedMessage ?? 'Codex session ended before goal control delivery');
          }
        };
        let committed = false;
        validate();
        await beforeDelivery({
          validate,
          commit: () => {
            committed = true;
          },
        });
        if (!committed) throw new Error('Codex goal control handoff was not committed');
        if (hasTerminalPendingFinish(session) || isTerminalSessionStatus(session.status)) {
          throw new Error(session.pendingFinish?.failedMessage ?? 'Codex session ended before goal control delivery');
        }
        await this.deliverReservedGoalControl(session, request, operation);
        if (session.activeTurnId && session.pendingFinish && !session.pendingFinish.failedMessage && !session.pendingFinish.aborted) {
          session.pendingFinish = null;
        }
        return true;
      } finally {
        session.activeDeliveryReservations -= 1;
        this.#port.flushPendingFinish(session);
      }
    });
    session.activeInputChain = delivery.then(() => undefined, () => undefined);
    return delivery;
  }

  async deliverReservedGoalControl(
    session: RunningCodexSession,
    request: CodexResumeRequest,
    operation: CodexOperation,
  ): Promise<void> {
    if (request.codexGoalCommand) {
      await this.handleCommand(
        session.client,
        session,
        request.codexGoalCommand,
        request,
        operation,
        {
          keepSession: true,
          propagateDeliveryFailure: true,
        },
      );
      return;
    }

    const attachments = await writeAttachmentsToTempFiles(request.images);
    this.#retainAttachmentCleanup(session, attachments.cleanup);
    const command = goalObjectiveWithAttachmentPaths(request.command, [], attachments.filePaths);
    const input = buildUserInput(command, attachments.imagePaths);
    const startParams = buildTurnStartParams({
      threadId: session.threadId,
      command,
      imagePaths: attachments.imagePaths,
      model: request.model,
      projectPath: request.projectPath,
      permissionMode: request.permissionMode,
      thinkingMode: request.thinkingMode,
      clientMessageId: request.clientMessageId,
    });
    let turnId = session.activeTurnId;
    let transitions = 0;

    if (!turnId && session.goal?.status === 'active') {
      turnId = await waitForTurnStart(this.#port.sessions, session, GOAL_TURN_START_TIMEOUT_MS);
    }
    let turnAttemptGeneration = session.turnAttemptGeneration;

    while (transitions < MAX_GOAL_CONTROL_DELIVERY_TRANSITIONS) {
      if (session.turnAttemptGeneration !== turnAttemptGeneration) {
        throw new TurnStartWaitCancelledError('Codex turn changed before goal control delivery');
      }
      if (this.#port.sessions.get(session.threadId) !== session || hasTerminalPendingFinish(session)) {
        throw new TurnStartWaitCancelledError('Codex session ended before goal control delivery');
      }
      if (!turnId && session.activeTurnId) turnId = session.activeTurnId;

      if (!turnId) {
        const previousTurnId = session.activeTurnId;
        try {
          session.nextTurnOperation = operation;
          const turn = await session.client.startTurn(startParams);
          if (!this.#port.canApplyTurnAttempt(session, turnAttemptGeneration)) return;
          adoptTurn(session, turn.turn.id, operation);
          return;
        } catch (error) {
          const isTurnTransition = isActiveTurnConflictError(error) || isActiveTurnNotSteerableError(error);
          if (session.turnAttemptGeneration !== turnAttemptGeneration) {
            const nextGeneration = isTurnTransition
              ? this.#port.generationAcrossTurnBoundary(session, turnAttemptGeneration)
              : null;
            if (nextGeneration === null) throw error;
            turnAttemptGeneration = nextGeneration;
          }
          if (!this.#port.canApplyTurnAttempt(session, turnAttemptGeneration)) throw error;
          if (!isTurnTransition) throw error;
          turnId = await waitForDifferentTurnStart(
            this.#port.sessions,
            session,
            previousTurnId,
            GOAL_TURN_START_TIMEOUT_MS,
          );
          const nextGeneration = this.#port.generationAcrossTurnBoundary(session, turnAttemptGeneration);
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
        if (!this.#port.canApplyTurnAttempt(session, turnAttemptGeneration)) return;
        return;
      } catch (error) {
        const isNonSteerable = isActiveTurnNotSteerableError(error);
        const actualTurnId = actualTurnIdFromSteerMismatch(error);
        const noActiveTurn = isNoActiveTurnError(error);
        const isTurnTransition = isNonSteerable || actualTurnId !== null || noActiveTurn;
        if (session.turnAttemptGeneration !== turnAttemptGeneration) {
          const nextGeneration = isTurnTransition
            ? this.#port.generationAcrossTurnBoundary(session, turnAttemptGeneration)
            : null;
          if (nextGeneration === null) throw error;
          turnAttemptGeneration = nextGeneration;
        }
        if (!this.#port.canApplyTurnAttempt(session, turnAttemptGeneration)) throw error;
        if (actualTurnId && actualTurnId !== turnId) {
          adoptTurn(session, actualTurnId, operation);
          turnId = actualTurnId;
          transitions += 1;
          continue;
        }
        if (actualTurnId) throw error;
        if (isNonSteerable) {
          turnId = await waitForDifferentTurnStart(
            this.#port.sessions,
            session,
            turnId,
            GOAL_TURN_START_TIMEOUT_MS,
          );
          const nextGeneration = this.#port.generationAcrossTurnBoundary(session, turnAttemptGeneration);
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

  #retainAttachmentCleanup(session: RunningCodexSession, cleanup: () => Promise<void>): void {
    const previous = session.cleanupAttachments;
    session.cleanupAttachments = previous
      ? async () => {
        await Promise.all([previous(), cleanup()]);
      }
      : cleanup;
  }

  async synchronizeRestoredGoal(
    client: CodexAppServerClient,
    session: RunningCodexSession,
  ): Promise<void> {
    const response = await client.getThreadGoal(session.threadId);
    session.goal = response.goal;
    session.managesGoalLifecycle = response.goal?.status === 'active';
    if (session.managesGoalLifecycle) session.goalOperation = session.sourceOperation;
  }

  handleGoalUpdated(client: CodexAppServerClient, params: ThreadGoalUpdatedNotification): void {
    const session = sessionForClientThread(this.#port.sessions, client, params.threadId);
    if (!session) return;
    session.goal = params.goal;
    if (params.goal.status === 'active') session.managesGoalLifecycle = true;
    if (
      session.managesGoalLifecycle
      && params.goal.status !== 'active'
      && session.completedGoalTurn
      && !session.activeTurnId
    ) {
      this.#port.finishSession(session, {}, session.lastTurnOperation ?? session.sourceOperation);
    }
  }

  handleGoalCleared(client: CodexAppServerClient, params: ThreadGoalClearedNotification): void {
    const session = sessionForClientThread(this.#port.sessions, client, params.threadId);
    if (!session) return;
    if (session.ignoredGoalClears > 0) {
      session.ignoredGoalClears -= 1;
      return;
    }
    session.goal = null;
    session.goalAttachments.queueClear();
    if (session.managesGoalLifecycle && !session.activeTurnId) {
      this.#port.finishSession(session, {}, session.lastTurnOperation ?? session.sourceOperation);
    }
  }

  async #clearThreadGoal(client: CodexAppServerClient, session: RunningCodexSession) {
    session.ignoredGoalClears += 1;
    try {
      const response = await client.clearThreadGoal(session.threadId);
      if (!response.cleared) this.#releaseIgnoredGoalClear(session);
      return response;
    } catch (error) {
      this.#releaseIgnoredGoalClear(session);
      throw error;
    }
  }

  async #setNewThreadGoal(
    client: CodexAppServerClient,
    session: RunningCodexSession,
    objective: string,
  ): Promise<ThreadGoalSetResponse> {
    session.managesGoalLifecycle = true;
    return client.setThreadGoal(session.threadId, { objective, status: 'active' });
  }

  async #replaceThreadGoal(
    client: CodexAppServerClient,
    session: RunningCodexSession,
    previousGoal: CodexThreadGoal,
    objective: string,
  ): Promise<ThreadGoalSetResponse> {
    const previouslyManaged = session.managesGoalLifecycle;
    let cleared: boolean;
    try {
      cleared = (await this.#clearThreadGoal(client, session)).cleared;
    } catch (clearError) {
      let reconciled = false;
      let clearCommitted = false;
      try {
        session.goal = (await client.getThreadGoal(session.threadId)).goal;
        reconciled = true;
        clearCommitted = !session.goal;
      } catch (reconcileError) {
        this.#port.logger.warn('Codex goal reconciliation failed after replacement clear', {
          error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
        });
      }
      if (clearCommitted) {
        let restored = false;
        try {
          session.goal = (await client.setThreadGoal(session.threadId, {
            objective: previousGoal.objective,
            status: previousGoal.status,
            tokenBudget: previousGoal.tokenBudget,
          })).goal;
          restored = true;
        } catch (rollbackError) {
          this.#port.logger.warn('Codex goal restoration failed after replacement clear', {
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
        if (!restored) await this.#reconcileGoalAfterReplacement(client, session);
      }
      if (reconciled && !clearCommitted) this.#releaseIgnoredGoalClear(session);
      session.managesGoalLifecycle = previouslyManaged || session.goal?.status === 'active';
      throw clearError;
    }
    session.managesGoalLifecycle = true;
    try {
      return await client.setThreadGoal(session.threadId, { objective, status: 'active' });
    } catch (replacementError) {
      if (cleared) {
        try {
          session.goal = (await client.setThreadGoal(session.threadId, {
            objective: previousGoal.objective,
            status: previousGoal.status,
            tokenBudget: previousGoal.tokenBudget,
          })).goal;
        } catch (rollbackError) {
          this.#port.logger.warn('Codex goal restoration failed after replacement', {
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
      }
      await this.#reconcileGoalAfterReplacement(client, session);
      session.managesGoalLifecycle = previouslyManaged || session.goal?.status === 'active';
      throw replacementError;
    }
  }

  async #reconcileGoalAfterReplacement(client: CodexAppServerClient, session: RunningCodexSession): Promise<void> {
    try {
      session.goal = (await client.getThreadGoal(session.threadId)).goal;
    } catch (error) {
      this.#port.logger.warn('Codex goal reconciliation failed after replacement', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #releaseIgnoredGoalClear(session: RunningCodexSession): void {
    if (session.ignoredGoalClears > 0) session.ignoredGoalClears -= 1;
  }
}
