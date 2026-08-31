import { AssistantMessage, ErrorMessage, type ChatMessage } from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import {
  publishFailed,
  publishFinished,
  publishPermissionRequested,
  publishRows,
  type CodexOperation,
} from './operation-routes.js';
import {
  type AgentGoalControlHandoff,
  type AgentLogger,
  type AgentSteerRequest,
  type AgentSteerResult,
  type AgentSteerTarget,
} from '@garcon/server-agent-interface';
import { CodexHistoryService } from '../history-source.js';
import {
  assertCodexExecutionOpen,
  markCodexExecutionStarted,
  type CodexChatEntry,
  type CodexForkSessionRequest,
  type CodexResumeRequest,
  type CodexStartedSession,
  type CodexStartRequest,
} from '../runtime-types.js';
import type { PermissionMode } from '@garcon/common/chat-modes';
import { buildApprovalMessage, buildApprovalResponse, cancelPendingApprovals, createPendingApproval, isApprovalRequest, type CodexPendingApproval } from './approvals.js';
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from './client.js';
import { convertCodexRawCodeModeItem } from './converter.js';
import { accessibleThreadPath, waitForMaterializedThread } from './durability.js';
import { NativePathDiscoveryRefreshLimiter } from './native-path-discovery-refresh.js';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import type {
  CodexThread,
  CodexThreadGoal,
  ErrorNotification,
  ItemCompletedNotification,
  JsonRpcNotification,
  JsonRpcServerRequest,
  RawResponseItemCompletedNotification,
  ThreadGoalClearedNotification,
  ThreadGoalSetResponse,
  ThreadGoalUpdatedNotification,
  TurnCompletedNotification,
  TurnStartedNotification,
} from './protocol.js';
import {
  buildCodexEnv,
  buildInjectedContextItems,
  buildThreadForkParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  parseLeadingSlashCommand,
  writeAttachmentsToTempFiles,
} from './request-builders.js';
import { CodexSkillDiscovery, type CodexSkillRef } from '../slash-command-discovery.js';
import type { CodexGoalCommand } from '../goal-command.js';
import { GoalAttachmentOperationQueue, GoalAttachmentOperations } from './goal-attachment-operations.js';
import { cleanupOwnedGoalAttachments } from './goal-files.js';
import { editedGoalStatus, formatGoalStatusMessage, formatGoalUpdatedMessage, goalStatusLabel } from './goal-display.js';
import { CodexTurnItemLedger } from './turn-item-ledger.js';
import {
  rejectedCodexSteer,
  steerCodexSession,
} from './steering.ts';
import {
  adoptTurn,
  cancelThreadSettingsConfirmation,
  cancelTurnStartWaiters,
  sessionForClientThread,
  sourceForClientThread,
  sourceForClientTurn,
  TurnStartWaitCancelledError,
  waitForTurnStart,
  type BufferedClientEvent,
  type CodexAppServerRuntimeOptions,
  type FinishSessionOptions,
  type GoalCommandOptions,
  type RunningCodexSession,
} from './runtime-session-state.js';
import {
  assertEffectiveCodexServiceTier,
  codexFastModeError,
  type CodexServiceTier,
} from '../service-tier.js';
import {
  CodexThreadSettingsController,
  type CodexSessionSettingsPatch,
  type CodexSessionSettingsUpdateOutcome,
} from './thread-settings-controller.js';
import {
  CAPACITY_RETRY_DELAYS_MS,
  delay,
  denialResponseForRequest,
  GOAL_TURN_START_TIMEOUT_MS,
  hasActiveGoalContinuation,
  hasTerminalPendingFinish,
  humanizeCodexAppServerError,
  isActiveSessionStatus,
  isCapacityError,
  isTerminalSessionStatus,
  isUtilityOverload,
  MAX_CAPACITY_RETRIES,
  mergeFinishOptions,
  NOOP_LOGGER,
} from './runtime-support.js';
import { deliverReservedGoalControl } from './goal-control-delivery.js';

export type { CodexAppServerRuntimeOptions } from './runtime-session-state.js';
export type { CodexSessionSettingsUpdateOutcome } from './thread-settings-controller.js';

export class CodexAppServerRuntime {
  #sessions = new Map<string, RunningCodexSession>();
  #sources = new Map<CodexAppServerClient, RunningCodexSession>();
  #terminalOperations = new WeakSet<CodexOperation>();
  #steerTargets = new WeakMap<AgentSteerTarget, {
    session: RunningCodexSession;
    turnId: string;
  }>();
  #pendingApprovals = new Set<
    CodexPendingApproval & { client: CodexAppServerClient; operation: CodexOperation }
  >();
  #bufferingClients = new Set<CodexAppServerClient>();
  #bufferedClientEvents = new Map<CodexAppServerClient, BufferedClientEvent[]>();
  #clientShutdowns = new Set<Promise<void>>();
  #utilityClient: CodexAppServerClient | null = null;
  #utilityQueue: Promise<unknown> = Promise.resolve();
  #threadListCaches = new Map<boolean, Promise<Map<string, CodexThread>>>();
  #createClient: (options?: CodexAppServerClientOptions) => CodexAppServerClient;
  #materializationTimeoutMs: number;
  #capacityRetryDelaysMs: readonly number[];
  #capacityRetryDelay: (delayMs: number) => Promise<void>;
  #nativePathDiscoveryRefresh: NativePathDiscoveryRefreshLimiter;
  #logger: AgentLogger;
  #skillDiscovery: CodexSkillDiscovery;
  #cleanupOwnedGoalAttachments: typeof cleanupOwnedGoalAttachments;
  #goalAttachmentQueue = new GoalAttachmentOperationQueue();
  #history: CodexHistoryService;
  #threadSettings: CodexThreadSettingsController;
  #idlePurger = new IdleSessionPurger<RunningCodexSession>({
    sessions: () => this.#sessions.entries(),
    isRunning: (session) => isActiveSessionStatus(session.status),
    lastActivityAt: () => 0,
    purge: (threadId, session) => {
      this.#sessions.delete(threadId);
      cancelThreadSettingsConfirmation(session, 'Codex session was purged');
      void session.cleanupAttachments?.();
      void this.#shutdownClient(session.client);
    },
  }, { maxIdleMs: 0 });

  constructor(options: CodexAppServerRuntimeOptions = {}) {
    this.#createClient = options.createClient ?? ((clientOptions) => new CodexAppServerClient(clientOptions));
    this.#materializationTimeoutMs = options.materializationTimeoutMs ?? 10_000;
    this.#capacityRetryDelaysMs = (options.capacityRetryDelaysMs ?? CAPACITY_RETRY_DELAYS_MS)
      .slice(0, MAX_CAPACITY_RETRIES);
    this.#capacityRetryDelay = options.capacityRetryDelay ?? delay;
    this.#nativePathDiscoveryRefresh = new NativePathDiscoveryRefreshLimiter(options.nativePathDiscoveryRefresh);
    this.#logger = options.logger ?? NOOP_LOGGER;
    this.#cleanupOwnedGoalAttachments = options.cleanupOwnedGoalAttachments ?? cleanupOwnedGoalAttachments;
    this.#history = new CodexHistoryService({
      createClient: this.#createClient,
      logger: this.#logger,
    });
    this.#skillDiscovery = options.skillDiscovery ?? new CodexSkillDiscovery({
      logger: this.#logger,
    });
    this.#threadSettings = new CodexThreadSettingsController({
      sessions: this.#sessions,
      sources: this.#sources,
      pendingApprovals: this.#pendingApprovals,
      logger: this.#logger,
      modelListTimeoutMs: options.modelListTimeoutMs,
      modelListMaxPages: options.modelListMaxPages,
      threadSettingsTimeoutMs: options.threadSettingsTimeoutMs,
      flushPendingFinish: (session) => this.#flushPendingFinish(session),
      publishFailed: (session, message, operation) => {
        this.#publishFailedOnce(session, message, operation);
      },
      shutdownClient: (client) => this.#shutdownClient(client),
    });
  }

  // Resolves available skills only when the command opens with a "/<name>"
  // token, so ordinary messages never trigger a skills probe.
  async #resolveTurnSkills(command: string, projectPath: string): Promise<CodexSkillRef[] | undefined> {
    if (!projectPath || !parseLeadingSlashCommand(command)) return undefined;
    try {
      return await this.#skillDiscovery.skillRefs(projectPath);
    } catch {
      return undefined;
    }
  }

  async #startRequestedTurn(
    client: CodexAppServerClient,
    session: RunningCodexSession,
    request: CodexStartRequest | CodexResumeRequest,
    operation: CodexOperation,
  ): Promise<void> {
    if (request.codexGoalCommand) {
      if ('codexSeedContext' in request && request.codexSeedContext) {
        await client.injectThreadItems({
          threadId: session.threadId,
          items: buildInjectedContextItems(request.codexSeedContext),
        });
      }
      await this.#handleGoalCommand(
        client,
        session,
        request.codexGoalCommand,
        request,
        operation,
        { keepSession: false },
      );
      return;
    }

    const attachments = await writeAttachmentsToTempFiles(request.images);
    session.cleanupAttachments = attachments.cleanup;
    const skills = await this.#resolveTurnSkills(request.command, request.projectPath);
    const turnAttemptGeneration = session.turnAttemptGeneration;
    session.nextTurnOperation = operation;
    const turn = await client.startTurn(buildTurnStartParams({
      threadId: session.threadId,
      command: request.command,
      imagePaths: attachments.imagePaths,
      filePaths: attachments.filePaths,
      model: request.model,
      serviceTier: request.serviceTier,
      projectPath: request.projectPath,
      permissionMode: request.permissionMode,
      thinkingMode: request.thinkingMode,
      clientMessageId: request.clientMessageId,
      skills,
    }));
    if (!this.#canApplyTurnAttempt(session, turnAttemptGeneration)) return;
    adoptTurn(session, turn.turn.id, operation);
  }

  async #handleGoalCommand(
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
            publishRows(this.#logger, session.chatId, [new ErrorMessage(
              new Date().toISOString(),
              `An unfinished Codex goal is already ${goalStatusLabel(current.goal.status)}: ${current.goal.objective}\nUse /goal replace <objective> to replace it explicitly, or /goal clear first.`,
            )], operation);
            if (!keepSession) this.#finishSession(session, {}, operation);
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
          await waitForTurnStart(this.#sessions, session, GOAL_TURN_START_TIMEOUT_MS);
          return;
        }
        case 'status': {
          const response = goalSynchronized
            ? { goal: session.goal }
            : await client.getThreadGoal(session.threadId);
          session.goal = response.goal;
          if (response.goal?.status === 'active') session.managesGoalLifecycle = true;
          publishRows(this.#logger, session.chatId, [
            new AssistantMessage(new Date().toISOString(), formatGoalStatusMessage(response.goal)),
          ], operation);
          if (!keepSession && !hasActiveGoalContinuation(session)) this.#finishSession(session, {}, operation);
          return;
        }
        case 'clear': {
          const response = await session.goalAttachments.clear(() => this.#clearThreadGoal(client, session));
          if (response.cleared) session.goal = null;
          const message = response.cleared ? 'Codex goal cleared.' : 'No Codex goal was set.';
          publishRows(this.#logger, session.chatId, [new AssistantMessage(new Date().toISOString(), message)], operation);
          if (!keepSession || !session.activeTurnId) this.#finishSession(session, {}, operation);
          return;
        }
        case 'pause': {
          const response = await client.setThreadGoalStatus(session.threadId, 'paused');
          session.goal = response.goal;
          publishRows(this.#logger, session.chatId, [
            new AssistantMessage(new Date().toISOString(), formatGoalUpdatedMessage('paused', response.goal)),
          ], operation);
          if (!keepSession || !session.activeTurnId) this.#finishSession(session, {}, operation);
          return;
        }
        case 'resume': {
          const previouslyManaged = session.managesGoalLifecycle;
          const turnAttemptGeneration = session.turnAttemptGeneration;
          session.goalOperation = operation;
          session.nextTurnOperation = operation;
          const response = await client.setThreadGoalStatus(session.threadId, 'active');
          if (!this.#canApplyTurnAttempt(session, turnAttemptGeneration)) return;
          session.goal = response.goal;
          if (response.goal.status === 'active') {
            session.managesGoalLifecycle = true;
            await waitForTurnStart(this.#sessions, session, GOAL_TURN_START_TIMEOUT_MS);
          } else {
            session.managesGoalLifecycle = previouslyManaged;
            publishRows(this.#logger, session.chatId, [
              new AssistantMessage(new Date().toISOString(), formatGoalUpdatedMessage('updated', response.goal)),
            ], operation);
            if (!hasActiveGoalContinuation(session)) this.#finishSession(session, {}, operation);
          }
          return;
        }
        case 'edit': {
          if (!command.objective) {
            publishRows(this.#logger, session.chatId, [new ErrorMessage(
              new Date().toISOString(),
              'Usage: /goal edit <objective>',
            )], operation);
            if (!keepSession) this.#finishSession(session, {}, operation);
            return;
          }
          const editedObjective = command.objective;
          const current = goalSynchronized
            ? session.goal
            : (await client.getThreadGoal(session.threadId)).goal;
          if (!current) {
            publishRows(this.#logger, session.chatId, [new ErrorMessage(
              new Date().toISOString(),
              'No Codex goal is set. Start one with /goal <objective>.',
            )], operation);
            if (!keepSession) this.#finishSession(session, {}, operation);
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
            await waitForTurnStart(this.#sessions, session, GOAL_TURN_START_TIMEOUT_MS);
          } else {
            session.managesGoalLifecycle = previouslyManaged;
            publishRows(this.#logger, session.chatId, [
              new AssistantMessage(new Date().toISOString(), formatGoalUpdatedMessage('updated', response.goal)),
            ], operation);
            if (!keepSession || !session.activeTurnId) this.#finishSession(session, {}, operation);
          }
          return;
        }
        case 'unsupported':
          publishRows(this.#logger, session.chatId, [
            new ErrorMessage(
              new Date().toISOString(),
              `Unsupported Codex goal command: /goal ${command.subcommand}. Use /goal <objective>, /goal replace <objective>, /goal edit <objective>, /goal pause, /goal resume, or /goal clear.`,
            ),
          ], operation);
          if (!keepSession) this.#finishSession(session, {}, operation);
          return;
      }
    } catch (error) {
      if (error instanceof TurnStartWaitCancelledError) {
        if (propagateDeliveryFailure) throw error;
        return;
      }
      publishRows(this.#logger, session.chatId, [new ErrorMessage(new Date().toISOString(), humanizeCodexAppServerError(error))], operation);
      if (!hasActiveGoalContinuation(session)) {
        this.#finishSession(session, {}, operation);
      }
      if (propagateDeliveryFailure) throw error;
      return;
    }
  }

  captureSteerTarget(agentSessionId: string): AgentSteerTarget | null {
    const session = this.#sessions.get(agentSessionId);
    if (
      !session
      || isTerminalSessionStatus(session.status)
      || hasTerminalPendingFinish(session)
      || !session.activeTurnId
    ) return null;
    const target = Object.freeze({});
    this.#steerTargets.set(target, { session, turnId: session.activeTurnId });
    return target;
  }

  async steer(request: AgentSteerRequest): Promise<AgentSteerResult> {
    const session = this.#sessions.get(request.agentSessionId);
    if (!session || isTerminalSessionStatus(session.status) || hasTerminalPendingFinish(session)) {
      return rejectedCodexSteer('no-active-turn', 'No active Codex turn');
    }
    const captured = request.target ? this.#steerTargets.get(request.target) : undefined;
    if (!captured) {
      return rejectedCodexSteer('no-active-turn', 'No active Codex turn');
    }
    this.#steerTargets.delete(request.target!);
    if (captured.session !== session || captured.turnId !== session.activeTurnId) {
      return rejectedCodexSteer('turn-changed', 'The active Codex turn changed');
    }
    return steerCodexSession(
      session,
      captured.turnId,
      request,
      () => this.#flushPendingFinish(session),
    );
  }

  async submitGoalControl(
    request: CodexResumeRequest,
    beforeDelivery: (handoff: AgentGoalControlHandoff) => Promise<void> = async (handoff) => {
      handoff.validate();
      handoff.commit();
    },
  ): Promise<boolean> {
    const session = this.#sessions.get(request.agentSessionId);
    if (!session || session.status === 'completed' || session.status === 'failed' || session.status === 'aborted') {
      return false;
    }
    if (!session.managesGoalLifecycle) return false;
    const operation = request.operation;
    const delivery = session.activeInputChain.then(async () => {
      if (this.#sessions.get(request.agentSessionId) !== session) return false;
      if (
        !session.managesGoalLifecycle
        || session.status === 'failed'
        || session.status === 'aborted'
        || session.status === 'completed'
        || hasTerminalPendingFinish(session)
      ) return false;
      const settingsOutcome = await this.updateSessionSettings(
        request.agentSessionId,
        {
          model: request.model,
          permissionMode: request.permissionMode,
          serviceTier: request.serviceTier,
        },
      );
      if (
        settingsOutcome.kind === 'session-absent'
        || this.#sessions.get(request.agentSessionId) !== session
        || hasTerminalPendingFinish(session)
        || isTerminalSessionStatus(session.status)
      ) return false;
      session.activeDeliveryReservations += 1;
      try {
        const validate = () => {
          if (
            this.#sessions.get(request.agentSessionId) !== session
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
        await this.#deliverReservedGoalControl(session, request, operation);
        if (session.activeTurnId && session.pendingFinish && !session.pendingFinish.failedMessage && !session.pendingFinish.aborted) {
          session.pendingFinish = null;
        }
        return true;
      } finally {
        session.activeDeliveryReservations -= 1;
        this.#flushPendingFinish(session);
      }
    });
    session.activeInputChain = delivery.then(() => undefined, () => undefined);
    return delivery;
  }

  #deliverReservedGoalControl(
    session: RunningCodexSession,
    request: CodexResumeRequest,
    operation: CodexOperation,
  ): Promise<void> {
    return deliverReservedGoalControl({
      sessions: this.#sessions,
      session,
      request,
      operation,
      handleGoalCommand: () => this.#handleGoalCommand(
        session.client,
        session,
        request.codexGoalCommand!,
        request,
        operation,
        { keepSession: true, propagateDeliveryFailure: true },
      ),
    });
  }

  async startSession(
    request: CodexStartRequest,
  ): Promise<CodexStartedSession> {
    assertCodexExecutionOpen(request);
    const operation = request.operation;
    const client = this.#newClient(request, true);
    let activeSession: RunningCodexSession | null = null;
    let materializedThreadId: string | null = null;

    try {
      const initialized = await client.connect();
      assertCodexExecutionOpen(request);
      const started = await client.startThread(buildThreadStartParams(request));
      materializedThreadId = started.thread.id;
      const confirmedServiceTier = assertEffectiveCodexServiceTier({
        requested: request.serviceTier,
        effective: started.serviceTier,
        model: request.model,
        operation: 'thread/start',
      });
      const threadId = started.thread.id;
      const session = this.#activateSession({
        chatId: request.chatId,
        threadId,
        nativePath: started.thread.path,
        codexHome: initialized.codexHome || null,
        client,
        permissionMode: request.permissionMode,
        confirmedModel: request.model,
        confirmedServiceTier,
        operation,
      });
      activeSession = session;
      session.managesGoalLifecycle = Boolean(request.codexGoalCommand);
      this.#releaseBufferedClientEvents(client);
      request.onSessionActivated?.({ agentSessionId: threadId, nativePath: started.thread.path });
      if (request.executionAdmission) await markCodexExecutionStarted(request);
      await this.#startRequestedTurn(client, session, request, operation);

      const nativePath = await waitForMaterializedThread(started.thread, {
        timeoutMs: this.#materializationTimeoutMs,
      });
      session.nativePath = nativePath;
      this.#threadListCaches.clear();
      return { agentSessionId: threadId, nativePath };
    } catch (error) {
      const message = humanizeCodexAppServerError(error);
      const admissionClosed = request.executionAdmission?.signal.aborted === true;
      if (activeSession) {
        this.#finishSession(
          activeSession,
          admissionClosed ? { aborted: true } : { failedMessage: message },
          operation,
        );
      } else {
        this.#discardBufferedClientEvents(client);
        if (materializedThreadId) {
          await this.#unsubscribeBestEffort(client, materializedThreadId);
        }
        if (!admissionClosed) {
          publishFailed(this.#logger, request.chatId, message, operation);
        }
        await this.#shutdownClient(client);
      }
      throw error;
    }
  }

  async runTurn(request: CodexResumeRequest): Promise<void> {
    assertCodexExecutionOpen(request);
    const operation = request.operation;
    const client = this.#newClient(request, true);
    let activeSession: RunningCodexSession | null = null;
    let materializedThreadId: string | null = null;

    try {
      const initialized = await client.connect();
      assertCodexExecutionOpen(request);
      const resumed = await client.resumeThread(buildThreadResumeParams(request));
      materializedThreadId = resumed.thread.id;
      const confirmedServiceTier = assertEffectiveCodexServiceTier({
        requested: request.serviceTier,
        effective: resumed.serviceTier,
        model: request.model,
        operation: 'thread/resume',
      });
      const session = this.#activateSession({
        chatId: request.chatId,
        threadId: resumed.thread.id,
        nativePath: resumed.thread.path ?? request.nativePath ?? null,
        codexHome: initialized.codexHome || null,
        client,
        permissionMode: request.permissionMode,
        confirmedModel: request.model,
        confirmedServiceTier,
        operation,
      });
      activeSession = session;
      session.activeDeliveryReservations += 1;
      try {
        if (this.#sessions.get(session.threadId) !== session) {
          throw new Error('Codex session ended while resuming the thread');
        }
        await this.#synchronizeRestoredGoal(client, session);
        const initialDelivery = session.activeInputChain.then(async () => {
          if (this.#sessions.get(session.threadId) !== session || hasTerminalPendingFinish(session)) {
            throw new TurnStartWaitCancelledError('Codex session ended while synchronizing the restored goal');
          }
          if (request.executionAdmission) await markCodexExecutionStarted(request);
          if (!request.codexGoalCommand) {
            if (session.managesGoalLifecycle) {
              await this.#deliverReservedGoalControl(session, request, operation);
            } else {
              await this.#startRequestedTurn(client, session, request, operation);
            }
          } else {
            await this.#handleGoalCommand(
              client,
              session,
              request.codexGoalCommand,
              request,
              operation,
              {
                keepSession: session.managesGoalLifecycle,
                goalSynchronized: true,
              },
            );
          }
          if (session.activeTurnId && !hasTerminalPendingFinish(session)) {
            session.pendingFinish = null;
          }
        });
        session.activeInputChain = initialDelivery.then(() => undefined, () => undefined);
        this.#releaseBufferedClientEvents(client);
        await initialDelivery;
      } finally {
        session.activeDeliveryReservations -= 1;
        this.#flushPendingFinish(session);
      }
    } catch (error) {
      const message = humanizeCodexAppServerError(error);
      const admissionClosed = request.executionAdmission?.signal.aborted === true;
      if (activeSession) {
        this.#discardBufferedClientEvents(client);
        this.#finishSession(
          activeSession,
          admissionClosed ? { aborted: true } : { failedMessage: message },
          operation,
        );
      } else {
        this.#discardBufferedClientEvents(client);
        if (materializedThreadId) {
          await this.#unsubscribeBestEffort(client, materializedThreadId);
        }
        if (!admissionClosed) {
          publishFailed(this.#logger, request.chatId, message, operation);
        }
        await this.#shutdownClient(client);
      }
      throw error;
    }
  }

  // Triggers native context compaction as its own turn. Mirrors runTurn but
  // starts the turn via thread/compact/start; the resulting contextCompaction
  // item and turn lifecycle arrive through the shared notification handlers.
  async compact(request: CodexResumeRequest): Promise<void> {
    assertCodexExecutionOpen(request);
    // A live session means a turn is already active for this thread; starting a
    // second one would overwrite the session map and leak the existing client.
    if (this.#sessions.has(request.agentSessionId)) {
      throw new Error('Cannot compact while a Codex turn is active');
    }

    const operation = request.operation;
    const client = this.#newClient(request, true);
    let activeSession: RunningCodexSession | null = null;
    let materializedThreadId: string | null = null;

    try {
      const initialized = await client.connect();
      assertCodexExecutionOpen(request);
      const resumed = await client.resumeThread(buildThreadResumeParams(request));
      materializedThreadId = resumed.thread.id;
      const confirmedServiceTier = assertEffectiveCodexServiceTier({
        requested: request.serviceTier,
        effective: resumed.serviceTier,
        model: request.model,
        operation: 'thread/resume',
      });
      const session = this.#activateSession({
        chatId: request.chatId,
        threadId: resumed.thread.id,
        nativePath: resumed.thread.path ?? request.nativePath ?? null,
        codexHome: initialized.codexHome || null,
        client,
        permissionMode: request.permissionMode,
        confirmedModel: request.model,
        confirmedServiceTier,
        operation,
      });
      activeSession = session;
      session.turnItems.markManualCompaction();
      this.#releaseBufferedClientEvents(client);
      if (request.executionAdmission) await markCodexExecutionStarted(request);
      session.nextTurnOperation = operation;
      await client.compactThread(resumed.thread.id);
    } catch (error) {
      const message = humanizeCodexAppServerError(error);
      const admissionClosed = request.executionAdmission?.signal.aborted === true;
      if (activeSession) {
        this.#finishSession(
          activeSession,
          admissionClosed ? { aborted: true } : { failedMessage: message },
          operation,
        );
      } else {
        this.#discardBufferedClientEvents(client);
        if (materializedThreadId) {
          await this.#unsubscribeBestEffort(client, materializedThreadId);
        }
        if (!admissionClosed) {
          publishFailed(this.#logger, request.chatId, message, operation);
        }
        await this.#shutdownClient(client);
      }
      throw error;
    }
  }

  async abort(agentSessionId: string): Promise<boolean> {
    const session = this.#sessions.get(agentSessionId);
    const turnId = session?.activeTurnId;
    if (!session) return false;
    if (!turnId) {
      session.status = 'aborted';
      cancelThreadSettingsConfirmation(session, 'Codex session aborted');
      cancelTurnStartWaiters(session, 'Codex session aborted');
      this.#finishSession(session, { aborted: true });
      return true;
    }
    if (session.status === 'interrupting') return true;
    // Set before awaiting because the RPC response and turn/completed can arrive in one stdout read.
    session.status = 'interrupting';
    try {
      await session.client.interruptTurn(session.threadId, turnId);
    } catch (error) {
      if (this.#sessions.get(agentSessionId) === session && session.status === 'interrupting') session.status = 'running';
      this.#logger.warn('Codex turn interruption failed', {
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (this.#sessions.get(agentSessionId) !== session) return true;
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    const status = this.#sessions.get(agentSessionId)?.status;
    return status !== undefined && isActiveSessionStatus(status);
  }

  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#sessions.values())
      .filter((session) => isActiveSessionStatus(session.status))
      .map((session) => ({ id: session.threadId, status: session.status, startedAt: session.startedAt }));
  }

  async loadMessages(session: CodexChatEntry, signal?: AbortSignal): Promise<ChatMessage[]> {
    return this.#history.load(session, signal);
  }

  async forkSession(args: CodexForkSessionRequest): Promise<CodexStartedSession | null> {
    const sourceSession = args.sourceSession;
    const sourceThreadId = sourceSession.agentSessionId;
    if (!sourceThreadId) return null;

    return this.#withOperationClient(args, async (client) => {
      const forked = await client.forkThread(buildThreadForkParams({
        agentSessionId: sourceThreadId,
        nativePath: sourceSession.nativePath,
        model: sourceSession.model,
        projectPath: sourceSession.projectPath,
        serviceTier: args.serviceTier,
        codexConfig: args.codexConfig,
      }));
      try {
        assertEffectiveCodexServiceTier({
          requested: args.serviceTier,
          effective: forked.serviceTier,
          model: sourceSession.model ?? forked.model,
          operation: 'thread/fork',
        });
      } catch (error) {
        await this.#unsubscribeBestEffort(client, forked.thread.id);
        throw error;
      }
      await this.#unsubscribeBestEffort(client, forked.thread.id);
      const nativePath = await waitForMaterializedThread(forked.thread, {
        timeoutMs: this.#materializationTimeoutMs,
      });
      this.#threadListCaches.clear();
      return { agentSessionId: forked.thread.id, nativePath };
    });
  }

  async resolveNativePath(session: CodexChatEntry): Promise<string | null> {
    if (!session.agentSessionId) return null;

    return accessibleThreadPath(await this.#getThreadListCache(false), session.agentSessionId);
  }

  requestNativePathDiscoveryRefresh(agentSessionId: string): void {
    // Bounds each session heavily while keeping unrelated chat retries responsive.
    if (!this.#nativePathDiscoveryRefresh.accept(agentSessionId)) return;
    this.#threadListCaches.delete(false);
  }

  async #resolvePermission(
    pending: CodexPendingApproval & { client: CodexAppServerClient; operation: CodexOperation },
    decision: { allow: boolean; alwaysAllow?: boolean },
  ): Promise<void> {
    if (!this.#pendingApprovals.has(pending)) {
      throw new Error('Codex permission occurrence is no longer pending');
    }
    pending.client.respond(pending.requestId, buildApprovalResponse(pending, decision));
    this.#pendingApprovals.delete(pending);
  }

  updateSessionSettings(
    agentSessionId: string,
    patch: CodexSessionSettingsPatch,
  ): Promise<CodexSessionSettingsUpdateOutcome> {
    return this.#threadSettings.update(agentSessionId, patch);
  }

  startPurgeTimer(): void {
    this.#idlePurger.start();
  }

  async shutdown(): Promise<void> {
    this.#idlePurger.stop();
    const sessions = [...new Set(this.#sources.values())];
    for (const session of sessions) {
      cancelThreadSettingsConfirmation(session, 'Codex runtime shut down');
      cancelTurnStartWaiters(session, 'Codex runtime shut down');
      void session.cleanupAttachments?.();
    }
    this.#sessions.clear();
    const utilityClient = this.#utilityClient;
    this.#utilityClient = null;
    this.#utilityQueue = Promise.resolve();
    this.#threadListCaches.clear();
    this.#bufferingClients.clear();
    this.#bufferedClientEvents.clear();
    const shutdowns = sessions.map((session) => this.#shutdownClient(session.client));
    if (utilityClient) shutdowns.push(this.#shutdownClient(utilityClient));
    shutdowns.push(this.#skillDiscovery.clear());
    await Promise.all([...this.#clientShutdowns, ...shutdowns]);
    for (const session of sessions) this.#retireSource(session.client);
  }

  #newClient(
    request: Pick<CodexStartRequest, 'envOverrides' | 'codexConfig'>,
    bufferNotifications = false,
  ): CodexAppServerClient {
    const client = this.#createClient({ env: buildCodexEnv(request.envOverrides, request.codexConfig) });
    if (bufferNotifications) this.#bufferingClients.add(client);
    this.#wireClient(client);
    return client;
  }

  async #withOperationClient<T>(
    request: Pick<CodexStartRequest, 'envOverrides' | 'codexConfig'>,
    operation: (client: CodexAppServerClient) => Promise<T>,
  ): Promise<T> {
    const client = this.#newClient(request);
    try {
      return await operation(client);
    } finally {
      await this.#shutdownClient(client);
    }
  }

  #shutdownClient(client: CodexAppServerClient): Promise<void> {
    const shutdown = Promise.resolve(client.shutdown()).catch((error) => {
      this.#logger.warn('Codex app-server shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.#clientShutdowns.add(shutdown);
    void shutdown.then(() => {
      this.#clientShutdowns.delete(shutdown);
    });
    return shutdown;
  }

  async #utility(): Promise<CodexAppServerClient> {
    if (!this.#utilityClient) {
      const client = this.#createClient();
      this.#utilityClient = client;
      this.#wireClient(client);
      client.on('exit', () => {
        if (this.#utilityClient === client) this.#utilityClient = null;
      });
    }
    await this.#utilityClient.connect();
    return this.#utilityClient;
  }

  #getThreadListCache(useStateDbOnly = true): Promise<Map<string, CodexThread>> {
    const cached = this.#threadListCaches.get(useStateDbOnly);
    if (cached) return cached;

    const pending = this.#loadThreadListCache(useStateDbOnly).catch((error) => {
      this.#threadListCaches.delete(useStateDbOnly);
      throw error;
    });
    this.#threadListCaches.set(useStateDbOnly, pending);
    return pending;
  }

  async #loadThreadListCache(useStateDbOnly: boolean): Promise<Map<string, CodexThread>> {
    const threads = new Map<string, CodexThread>();
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      const response = await this.#withUtilityClient((client) => client.listThreads({
        cursor,
        limit: 500,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
        useStateDbOnly,
      }));
      for (const thread of response.data ?? []) {
        threads.set(thread.id, thread);
      }
      cursor = response.nextCursor ?? null;
      pageCount += 1;
    } while (cursor && pageCount < 20);

    return threads;
  }

  async #withUtilityClient<T>(operation: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const scheduled = this.#utilityQueue
      .catch(() => undefined)
      .then(() => this.#runUtilityOperation(operation));
    this.#utilityQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  async #runUtilityOperation<T>(operation: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    let attempt = 0;

    while (true) {
      const client = await this.#utility();
      try {
        return await operation(client);
      } catch (error) {
        if (!isUtilityOverload(error) || attempt >= 3) throw error;
        attempt += 1;
        await delay(25 * attempt);
      }
    }
  }

  async #unsubscribeBestEffort(client: CodexAppServerClient, threadId: string): Promise<void> {
    try {
      await client.unsubscribeThread(threadId);
    } catch (error) {
      this.#logger.warn('Codex thread unsubscribe failed', {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #activateSession(args: {
    chatId: string;
    threadId: string;
    nativePath: string | null;
    codexHome: string | null;
    client: CodexAppServerClient;
    permissionMode: PermissionMode;
    confirmedModel: string;
    confirmedServiceTier: CodexServiceTier;
    operation: CodexOperation;
  }): RunningCodexSession {
    // Keyed by Codex's own turn id so an event it labels later still names the run that asked
    // for that turn, long after the session moved on to the next one.
    const turnRoutes = new Map<string, CodexOperation>();
    const session: RunningCodexSession = {
      chatId: args.chatId,
      threadId: args.threadId,
      nativePath: args.nativePath,
      codexHome: args.codexHome,
      client: args.client,
      activeTurnId: null,
      status: 'running',
      permissionMode: args.permissionMode,
      startedAt: new Date().toISOString(),
      turnStartWaiters: new Set(),
      goal: null,
      managesGoalLifecycle: false,
      completedGoalTurn: false,
      ignoredGoalClears: 0,
      activeInputChain: Promise.resolve(),
      confirmedModel: args.confirmedModel,
      confirmedServiceTier: args.confirmedServiceTier,
      prioritySupportModel: args.confirmedServiceTier === 'priority'
        ? args.confirmedModel
        : null,
      threadSettingsUpdateChain: Promise.resolve(),
      pendingThreadSettingsConfirmation: null,
      goalAttachments: new GoalAttachmentOperations({
        codexHome: args.codexHome,
        threadId: args.threadId,
        cleanup: this.#cleanupOwnedGoalAttachments,
        logger: this.#logger,
        chatId: args.chatId,
        queue: this.#goalAttachmentQueue,
      }),
      activeDeliveryReservations: 0,
      pendingFinish: null,
      pendingFinishOperation: null,
      liveCodeModeResultToolIds: new Map(),
      turnItems: new CodexTurnItemLedger((turnId, messages) => (
        publishRows(this.#logger, args.chatId, messages, turnRoutes.get(turnId))
      )),
      turnRoutes,
      capacityRetryCount: 0,
      turnAttemptGeneration: 0,
      pendingCapacityFailure: null,
      sourceOperation: args.operation,
      nextTurnOperation: args.operation,
      goalOperation: null,
      lastTurnOperation: null,
      terminalTurnIds: new Set(),
      superseded: false,
    };
    const previous = this.#sessions.get(args.threadId);
    if (previous) this.#supersedeSource(previous);
    this.#sessions.set(args.threadId, session);
    this.#sources.set(args.client, session);
    return session;
  }

  #wireClient(client: CodexAppServerClient): void {
    client.on('notification', (notification: JsonRpcNotification) => {
      if (this.#bufferingClients.has(client)) {
        this.#bufferClientEvent(client, { type: 'notification', notification });
        return;
      }
      this.#handleNotification(client, notification);
    });
    client.on('serverRequest', (request: JsonRpcServerRequest) => {
      if (this.#bufferingClients.has(client)) {
        this.#bufferClientEvent(client, { type: 'serverRequest', request });
        return;
      }
      this.#handleServerRequest(client, request);
    });
    client.on('stderr', () => this.#logger.warn('Codex app-server stderr'));
    client.on('warning', (message: string) => this.#logger.warn(message));
    client.on('exit', (code: number) => this.#handleClientExit(client, code));
  }

  #bufferClientEvent(client: CodexAppServerClient, event: BufferedClientEvent): void {
    const buffered = this.#bufferedClientEvents.get(client) ?? [];
    buffered.push(event);
    this.#bufferedClientEvents.set(client, buffered);
  }

  #releaseBufferedClientEvents(client: CodexAppServerClient): void {
    this.#bufferingClients.delete(client);
    const events = this.#bufferedClientEvents.get(client) ?? [];
    this.#bufferedClientEvents.delete(client);
    for (const event of events) {
      if (event.type === 'notification') {
        this.#handleNotification(client, event.notification);
      } else {
        this.#handleServerRequest(client, event.request);
      }
    }
  }

  #discardBufferedClientEvents(client: CodexAppServerClient): void {
    this.#bufferingClients.delete(client);
    this.#bufferedClientEvents.delete(client);
  }

  async #synchronizeRestoredGoal(
    client: CodexAppServerClient,
    session: RunningCodexSession,
  ): Promise<void> {
    const response = await client.getThreadGoal(session.threadId);
    session.goal = response.goal;
    session.managesGoalLifecycle = response.goal?.status === 'active';
    if (session.managesGoalLifecycle) session.goalOperation = session.sourceOperation;
  }

  #handleNotification(client: CodexAppServerClient, notification: JsonRpcNotification): void {
    switch (notification.method) {
      case 'turn/started':
        this.#handleTurnStarted(client, notification.params as TurnStartedNotification);
        break;
      case 'item/completed':
        this.#handleItemCompleted(client, notification.params as ItemCompletedNotification);
        break;
      case 'rawResponseItem/completed':
        this.#handleRawResponseItemCompleted(client, notification.params as RawResponseItemCompletedNotification);
        break;
      case 'turn/completed':
        this.#handleTurnCompleted(client, notification.params as TurnCompletedNotification);
        break;
      case 'thread/goal/updated':
        this.#handleGoalUpdated(client, notification.params as ThreadGoalUpdatedNotification);
        break;
      case 'thread/goal/cleared':
        this.#handleGoalCleared(client, notification.params as ThreadGoalClearedNotification);
        break;
      case 'thread/settings/updated':
        this.#threadSettings.handleNotification(client, notification.params);
        break;
      case 'error':
        this.#handleErrorNotification(client, notification.params as ErrorNotification);
        break;
    }
  }

  #handleTurnStarted(client: CodexAppServerClient, params: TurnStartedNotification): void {
    const session = sessionForClientThread(this.#sessions, client, params.threadId);
    if (!session) return;
    if (session.turnRoutes.has(params.turn.id)) return;
    const operation = session.nextTurnOperation ?? session.goalOperation ?? session.sourceOperation;
    if (!adoptTurn(session, params.turn.id, operation)) return;
    if (session.status !== 'interrupting') session.status = 'running';
    for (const waiter of session.turnStartWaiters) waiter.resolve(params.turn.id);
  }

  #handleGoalUpdated(client: CodexAppServerClient, params: ThreadGoalUpdatedNotification): void {
    const session = sessionForClientThread(this.#sessions, client, params.threadId);
    if (!session) return;
    session.goal = params.goal;
    if (params.goal.status === 'active') session.managesGoalLifecycle = true;
    if (
      session.managesGoalLifecycle
      && params.goal.status !== 'active'
      && session.completedGoalTurn
      && !session.activeTurnId
    ) {
      this.#finishSession(session, {}, session.lastTurnOperation ?? session.sourceOperation);
    }
  }

  #handleGoalCleared(client: CodexAppServerClient, params: ThreadGoalClearedNotification): void {
    const session = sessionForClientThread(this.#sessions, client, params.threadId);
    if (!session) return;
    if (session.ignoredGoalClears > 0) {
      session.ignoredGoalClears -= 1;
      return;
    }
    session.goal = null;
    session.goalAttachments.queueClear();
    if (session.managesGoalLifecycle && !session.activeTurnId) {
      this.#finishSession(session, {}, session.lastTurnOperation ?? session.sourceOperation);
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
        this.#logger.warn('Codex goal reconciliation failed after replacement clear', {
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
          this.#logger.warn('Codex goal restoration failed after replacement clear', {
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
          this.#logger.warn('Codex goal restoration failed after replacement', {
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
      this.#logger.warn('Codex goal reconciliation failed after replacement', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #releaseIgnoredGoalClear(session: RunningCodexSession): void {
    if (session.ignoredGoalClears > 0) session.ignoredGoalClears -= 1;
  }

  #handleItemCompleted(client: CodexAppServerClient, params: ItemCompletedNotification): void {
    const session = sourceForClientTurn(this.#sources, client, params.threadId, params.turnId);
    if (!session) return;
    session.turnItems.emit(params.turnId, params.item);
  }

  #handleRawResponseItemCompleted(client: CodexAppServerClient, params: RawResponseItemCompletedNotification): void {
    const session = sourceForClientTurn(this.#sources, client, params.threadId, params.turnId);
    if (!session) return;
    const messages = convertCodexRawCodeModeItem(
      params.item,
      new Date().toISOString(),
      session.liveCodeModeResultToolIds,
    );
    session.turnItems.emitConverted(params.turnId, params.item.id, messages);
  }

  #handleTurnCompleted(client: CodexAppServerClient, params: TurnCompletedNotification): void {
    const source = sourceForClientThread(this.#sources, client, params.threadId);
    if (source?.superseded) {
      void this.#shutdownClient(client);
      return;
    }
    const session = sourceForClientTurn(this.#sources, client, params.threadId, params.turn.id);
    if (!session) return;
    const operation = session.turnRoutes.get(params.turn.id);
    if (!operation) return;
    if (session.terminalTurnIds.has(params.turn.id)) {
      for (const item of params.turn.items) session.turnItems.emit(params.turn.id, item);
      return;
    }
    if (this.#sessions.get(session.threadId) !== session || session.activeTurnId !== params.turn.id) {
      for (const item of params.turn.items) session.turnItems.emit(params.turn.id, item);
      session.terminalTurnIds.add(params.turn.id);
      this.#publishDetachedTurnTerminal(session, params, operation);
      return;
    }
    void this.#completeTurn(session, params, operation).catch((error) => {
      if (
        this.#sessions.get(session.threadId) !== session
        || isTerminalSessionStatus(session.status)
        || hasTerminalPendingFinish(session)
      ) return;
      this.#finishSession(
        session,
        { failedMessage: humanizeCodexAppServerError(error) },
        operation,
      );
    });
  }

  async #completeTurn(
    session: RunningCodexSession,
    params: TurnCompletedNotification,
    operation: CodexOperation,
  ): Promise<void> {
    session.terminalTurnIds.add(params.turn.id);
    session.turnAttemptGeneration += 1;
    session.liveCodeModeResultToolIds.clear();
    session.lastTurnOperation = operation;
    for (const item of params.turn.items) session.turnItems.emit(params.turn.id, item);
    if (params.turn.status === 'failed') {
      const pendingCapacityFailure = session.pendingCapacityFailure?.turnId === params.turn.id
        ? session.pendingCapacityFailure
        : null;
      session.pendingCapacityFailure = null;
      const failedMessage = pendingCapacityFailure?.message
        ?? params.turn.error?.message
        ?? 'Codex turn failed';
      if (pendingCapacityFailure || isCapacityError(params.turn.error)) {
        if (await this.#retryCapacityFailure(session, operation)) return;
        this.#finishSession(session, { failedMessage }, operation);
        return;
      }
      if (session.managesGoalLifecycle && session.goal && session.goal.status !== 'active') {
        session.activeTurnId = null;
        session.completedGoalTurn = true;
        this.#finishSession(session, {}, operation);
        return;
      }
      this.#finishSession(session, { failedMessage }, operation);
      return;
    }
    const aborted = params.turn.status === 'interrupted' || session.status === 'interrupting';
    session.capacityRetryCount = 0;
    session.pendingCapacityFailure = null;
    session.status = 'completing';
    session.activeTurnId = null;
    this.#threadListCaches.clear();
    if (session.managesGoalLifecycle && !aborted) {
      session.completedGoalTurn = true;
      if (session.goal?.status === 'active') {
        session.status = 'running';
        return;
      }
    }
    this.#finishSession(session, { aborted, emitFinishedOnAbort: aborted }, operation);
  }

  #handleErrorNotification(client: CodexAppServerClient, params: ErrorNotification): void {
    const session = sourceForClientTurn(this.#sources, client, params.threadId, params.turnId);
    if (!session) return;
    const operation = session.turnRoutes.get(params.turnId);
    if (!operation) return;
    const message = params.error.message || params.error.additionalDetails || 'Codex app-server error';
    publishRows(this.#logger, session.chatId,
      [new ErrorMessage(new Date().toISOString(), message)],
      operation,
    );
    if (params.willRetry) return;
    if (this.#sessions.get(session.threadId) !== session || session.activeTurnId !== params.turnId) {
      this.#publishFailedOnce(session, message, operation);
      return;
    }
    if (isCapacityError(params.error)) {
      session.pendingCapacityFailure = { turnId: params.turnId, message };
      return;
    }
    this.#finishSession(session, { failedMessage: message }, operation);
  }

  async #retryCapacityFailure(
    session: RunningCodexSession,
    operation: CodexOperation,
  ): Promise<boolean> {
    const delayMs = this.#capacityRetryDelaysMs[session.capacityRetryCount];
    if (delayMs === undefined) return false;
    const resumesBlockedGoal = session.managesGoalLifecycle && session.goal?.status === 'blocked';
    if (session.managesGoalLifecycle && !resumesBlockedGoal) return false;

    session.capacityRetryCount += 1;
    const retryGeneration = ++session.turnAttemptGeneration;
    session.activeTurnId = null;
    session.status = 'running';
    await this.#capacityRetryDelay(delayMs);

    const retry = session.activeInputChain.then(async () => {
      if (
        this.#sessions.get(session.threadId) !== session
        || session.status !== 'running'
        || hasTerminalPendingFinish(session)
        || session.turnAttemptGeneration !== retryGeneration
      ) return true;

      session.activeDeliveryReservations += 1;
      try {
        if (resumesBlockedGoal) {
          if (
            !session.managesGoalLifecycle
            || session.goal?.status !== 'blocked'
            || session.activeTurnId
          ) return true;
          session.nextTurnOperation = operation;
          const response = await session.client.setThreadGoalStatus(session.threadId, 'active');
          if (
            this.#sessions.get(session.threadId) !== session
            || session.status !== 'running'
            || hasTerminalPendingFinish(session)
            || session.turnAttemptGeneration !== retryGeneration
          ) return true;
          session.goal = response.goal;
          if (response.goal.status !== 'active') return false;
          await waitForTurnStart(this.#sessions, session, GOAL_TURN_START_TIMEOUT_MS);
          return true;
        }

        if (session.activeTurnId) return true;
        if (!session.confirmedModel || !session.confirmedServiceTier) {
          throw codexFastModeError(
            'PROVIDER_FAILURE',
            'Codex could not confirm processing settings for the retry.',
            true,
            { operation: 'turn/start' },
          );
        }
        session.nextTurnOperation = operation;
        const turn = await session.client.startTurn({
          threadId: session.threadId,
          input: [],
          model: session.confirmedModel,
          serviceTier: session.confirmedServiceTier,
        });
        if (
          this.#sessions.get(session.threadId) !== session
          || session.status !== 'running'
          || hasTerminalPendingFinish(session)
          || session.turnAttemptGeneration !== retryGeneration
        ) return true;
        adoptTurn(session, turn.turn.id, operation);
        return true;
      } finally {
        session.activeDeliveryReservations -= 1;
        this.#flushPendingFinish(session);
      }
    });
    session.activeInputChain = retry.then(() => undefined, () => undefined);
    return retry;
  }

  #canApplyTurnAttempt(session: RunningCodexSession, generation: number): boolean {
    return this.#sessions.get(session.threadId) === session
      && (session.status === 'running' || session.status === 'completing')
      && !hasTerminalPendingFinish(session)
      && session.turnAttemptGeneration === generation;
  }

  #generationAcrossTurnBoundary(session: RunningCodexSession, generation: number): number | null {
    const currentGeneration = session.turnAttemptGeneration;
    // Allows an accepted delivery to cross one ordinary turn boundary while a
    // second generation advance keeps ownership with a nested capacity retry.
    return currentGeneration === generation || currentGeneration === generation + 1
      ? currentGeneration
      : null;
  }

  #handleServerRequest(client: CodexAppServerClient, request: JsonRpcServerRequest): void {
    if (!isApprovalRequest(request)) {
      client.reject(request.id, -32601, `Unsupported Codex app-server request: ${request.method}`);
      return;
    }

    const params = request.params && typeof request.params === 'object' ? request.params as Record<string, unknown> : {};
    const threadId = typeof params.threadId === 'string'
      ? params.threadId
      : typeof params.conversationId === 'string'
        ? params.conversationId
        : null;
    const nativeTurnId = typeof params.turnId === 'string' ? params.turnId : null;
    const session = threadId ? sourceForClientThread(this.#sources, client, threadId) : null;
    const operation = nativeTurnId ? session?.turnRoutes.get(nativeTurnId) : undefined;
    if (!session || !operation) {
      this.#logger.warn('Dropped an unowned Codex approval request', {
        threadId,
        nativeTurnId,
        method: request.method,
      });
      client.respond(request.id, denialResponseForRequest(request.method));
      return;
    }

    const pending = {
      ...createPendingApproval(session.chatId, request),
      client,
      operation,
    };
    if (session.permissionMode === 'manualBypass') {
      client.respond(request.id, buildApprovalResponse(pending, { allow: true, alwaysAllow: false }));
      return;
    }
    this.#pendingApprovals.add(pending);
    const message = buildApprovalMessage(pending);
    publishPermissionRequested(
      this.#logger,
      session.chatId,
      message,
      Object.freeze({
        permissionOccurrenceId: pending.permissionOccurrenceId,
        respond: (decision: PermissionDecisionPayload) => this.#resolvePermission(pending, decision),
      }),
      pending.operation,
    );
  }

  #handleClientExit(client: CodexAppServerClient, code: number): void {
    const session = this.#sources.get(client);
    if (!session) return;
    const isCurrent = this.#sessions.get(session.threadId) === session;
    this.#sources.delete(client);
    if (isCurrent) this.#sessions.delete(session.threadId);
    this.#discardBufferedClientEvents(client);
    cancelThreadSettingsConfirmation(session, 'Codex app-server client exited');
    cancelTurnStartWaiters(session, 'Codex app-server client exited');
    session.turnRoutes.clear();
    session.nextTurnOperation = null;
    session.goalOperation = null;
    cancelPendingApprovals(this.#logger, this.#pendingApprovals, client, 'cancelled');
    void session.cleanupAttachments?.();

    if (isCurrent && isActiveSessionStatus(session.status)) {
      const operation = session.pendingFinishOperation
        ?? session.lastTurnOperation
        ?? session.sourceOperation;
      session.status = 'failed';
      session.pendingFinish = null;
      session.pendingFinishOperation = null;
      this.#threadListCaches.clear();
      this.#publishFailedOnce(
        session,
        `Codex app-server exited with code ${code}`,
        operation,
      );
    }
  }

  #finishSession(
    session: RunningCodexSession,
    opts: FinishSessionOptions = {},
    operation: CodexOperation | null = null,
  ): void {
    if (this.#sessions.get(session.threadId) !== session) return;
    cancelTurnStartWaiters(session, 'Codex session finished');
    if (session.activeDeliveryReservations > 0) {
      session.pendingFinish = mergeFinishOptions(session.pendingFinish, opts);
      session.pendingFinishOperation = operation ?? session.pendingFinishOperation;
      return;
    }

    cancelThreadSettingsConfirmation(session, 'Codex session finished');
    this.#sessions.delete(session.threadId);
    this.#threadListCaches.clear();
    session.status = opts.failedMessage ? 'failed' : opts.aborted ? 'aborted' : 'completed';
    cancelPendingApprovals(
      this.#logger,
      this.#pendingApprovals,
      session.client,
      opts.aborted ? 'aborted' : 'session-complete',
    );
    void session.cleanupAttachments?.();

    if (opts.failedMessage) {
      this.#publishFailedOnce(session, opts.failedMessage, operation);
    } else if (!opts.aborted || opts.emitFinishedOnAbort) {
      this.#publishFinishedOnce(session, operation);
    }

    void this.#shutdownClient(session.client);
  }

  #flushPendingFinish(session: RunningCodexSession): void {
    if (session.activeDeliveryReservations > 0 || !session.pendingFinish) return;
    const pending = session.pendingFinish;
    const operation = session.pendingFinishOperation;
    session.pendingFinish = null;
    session.pendingFinishOperation = null;
    this.#finishSession(session, pending, operation);
  }

  #publishDetachedTurnTerminal(
    session: RunningCodexSession,
    params: TurnCompletedNotification,
    operation: CodexOperation,
  ): void {
    if (params.turn.status === 'failed') {
      this.#publishFailedOnce(
        session,
        params.turn.error?.message ?? 'Codex turn failed',
        operation,
      );
      return;
    }
    this.#publishFinishedOnce(session, operation);
  }

  #publishFinishedOnce(
    session: RunningCodexSession,
    operation: CodexOperation | null,
  ): void {
    if (operation && this.#terminalOperations.has(operation)) return;
    if (operation) this.#terminalOperations.add(operation);
    publishFinished(this.#logger, session.chatId, operation ?? undefined);
  }

  #publishFailedOnce(
    session: RunningCodexSession,
    message: string,
    operation: CodexOperation | null,
  ): void {
    if (operation && this.#terminalOperations.has(operation)) return;
    if (operation) this.#terminalOperations.add(operation);
    publishFailed(this.#logger, session.chatId, message, operation ?? undefined);
  }

  #retireSource(client: CodexAppServerClient): void {
    const session = this.#sources.get(client);
    if (!session) return;
    this.#sources.delete(client);
    if (this.#sessions.get(session.threadId) === session) this.#sessions.delete(session.threadId);
    cancelThreadSettingsConfirmation(session, 'Codex app-server client retired');
    session.turnRoutes.clear();
    session.nextTurnOperation = null;
    session.goalOperation = null;
    cancelPendingApprovals(this.#logger, this.#pendingApprovals, client, 'cancelled');
  }

  #supersedeSource(session: RunningCodexSession): void {
    session.superseded = true;
    cancelThreadSettingsConfirmation(session, 'Codex session was superseded');
    cancelTurnStartWaiters(session, 'Codex session was superseded');
    if (this.#sessions.get(session.threadId) === session) this.#sessions.delete(session.threadId);
    session.turnRoutes.clear();
    session.nextTurnOperation = null;
    session.goalOperation = null;
    cancelPendingApprovals(this.#logger, this.#pendingApprovals, session.client, 'cancelled');
  }

}
