import { AssistantMessage, ErrorMessage, PermissionCancelledMessage, PermissionResolvedMessage, type ChatMessage, type CompactionTrigger } from "../../../../common/chat-types.js";
import { promises as fs } from 'fs';
import { AgentEventEmitterRuntime } from "../../shared/event-emitter-runtime.js";
import { loadCodexChatMessages, getCodexPreviewFromNativePath, loadCodexChatMessagePage } from "../history-loader.js";
import type { AgentChatEntry, AgentSessionSettingsPatch, PermissionMode, ResumeTurnRequest, StartSessionRequest, StartedAgentSession } from "../../session-types.js";
import type { AgentTranscriptPage } from '../../types.js';
import { buildApprovalMessage, buildApprovalResponse, createPendingApproval, isApprovalRequest, type CodexPendingApproval } from './approvals.js';
import { CodexAppServerClient, CodexAppServerRpcError, type CodexAppServerClientOptions, type CodexAppServerMetric } from './client.js';
import { convertCodexAppServerLiveItem, convertCodexRawCodeModeItem } from './converter.js';
import { waitForMaterializedThread } from './durability.js';
import { createLogger } from '../../../lib/log.js';
import { IdleSessionPurger } from '../../shared/idle-session-purger.js';

const logger = createLogger('agents:codex:app-server:runtime');
import type {
  ErrorNotification,
  ItemCompletedNotification,
  JsonRpcNotification,
  JsonRpcServerRequest,
  CodexThread,
  CodexThreadGoal,
  CodexThreadGoalStatus,
  ThreadGoalClearedNotification,
  ThreadGoalUpdatedNotification,
  ThreadGoalSetResponse,
  RawResponseItemCompletedNotification,
  CodexTurnError,
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
  buildUserInput,
  goalObjectiveWithAttachmentPaths,
  parseLeadingSlashCommand,
  writeAttachmentsToTempFiles,
} from './request-builders.js';
import { getCodexSkillRefs, type CodexSkillRef } from '../slash-command-discovery.js';
import type { CodexGoalCommand } from '../goal-command.js';
import { cleanupMaterializedGoalDraft, materializeGoalDraft } from './goal-files.js';

type RunningStatus = 'running' | 'completing' | 'completed' | 'failed' | 'aborted';
type FinishSessionOptions = { failedMessage?: string; aborted?: boolean };
type GoalCommandOptions = {
  keepSession: boolean;
  goalSynchronized?: boolean;
  propagateDeliveryFailure?: boolean;
};
const GOAL_TURN_START_TIMEOUT_MS = 30_000;
const MAX_ACTIVE_INPUT_DELIVERY_TRANSITIONS = 8;
const MAX_CAPACITY_RETRIES = 3;
const CAPACITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

interface TurnStartWaiter {
  resolve: (turnId: string) => void;
  reject: (error: Error) => void;
}

class TurnStartWaitCancelledError extends Error {}

type BufferedClientEvent =
  | { type: 'notification'; notification: JsonRpcNotification }
  | { type: 'serverRequest'; request: JsonRpcServerRequest };

interface RunningCodexSession {
  chatId: string;
  threadId: string;
  nativePath: string | null;
  codexHome: string | null;
  client: CodexAppServerClient;
  activeTurnId: string | null;
  status: RunningStatus;
  permissionMode: PermissionMode;
  startedAt: string;
  // Set when this session was started by an explicit /compact, so the resulting
  // contextCompaction item is labeled 'manual' rather than 'auto'.
  manualCompactionPending?: boolean;
  cleanupAttachments?: () => Promise<void>;
  turnStartWaiters: Set<TurnStartWaiter>;
  goal: CodexThreadGoal | null;
  managesGoalLifecycle: boolean;
  completedGoalTurn: boolean;
  ignoredGoalClears: number;
  activeInputChain: Promise<void>;
  activeDeliveryReservations: number;
  pendingFinish: FinishSessionOptions | null;
  liveCodeModeCallIds: Set<string>;
  capacityRetryCount: number;
  pendingCapacityFailure: { turnId: string; message: string } | null;
}

interface CodexForkSessionRequest {
  sourceSession: AgentChatEntry;
  envOverrides?: Record<string, string>;
  codexConfig?: StartSessionRequest['codexConfig'];
}

export interface CodexAppServerRuntimeOptions {
  createClient?: (options?: CodexAppServerClientOptions) => CodexAppServerClient;
  materializationTimeoutMs?: number;
  capacityRetryDelaysMs?: readonly number[];
}

export class CodexAppServerRuntime extends AgentEventEmitterRuntime {
  #sessions = new Map<string, RunningCodexSession>();
  #pendingApprovals = new Map<string, CodexPendingApproval & { client: CodexAppServerClient }>();
  #bufferingClients = new Set<CodexAppServerClient>();
  #bufferedClientEvents = new Map<CodexAppServerClient, BufferedClientEvent[]>();
  #utilityClient: CodexAppServerClient | null = null;
  #utilityQueue: Promise<unknown> = Promise.resolve();
  #threadListCaches = new Map<boolean, Promise<Map<string, CodexThread>>>();
  #createClient: (options?: CodexAppServerClientOptions) => CodexAppServerClient;
  #materializationTimeoutMs: number;
  #capacityRetryDelaysMs: readonly number[];
  #idlePurger = new IdleSessionPurger<RunningCodexSession>({
    sessions: () => this.#sessions.entries(),
    isRunning: (session) => session.status === 'running' || session.status === 'completing',
    lastActivityAt: () => 0,
    purge: (threadId, session) => {
      this.#sessions.delete(threadId);
      void session.cleanupAttachments?.();
      session.client.shutdown();
    },
  }, { maxIdleMs: 0 });

  constructor(options: CodexAppServerRuntimeOptions = {}) {
    super();
    this.#createClient = options.createClient ?? ((clientOptions) => new CodexAppServerClient(clientOptions));
    this.#materializationTimeoutMs = options.materializationTimeoutMs ?? 10_000;
    this.#capacityRetryDelaysMs = (options.capacityRetryDelaysMs ?? CAPACITY_RETRY_DELAYS_MS)
      .slice(0, MAX_CAPACITY_RETRIES);
  }

  // Resolves available skills only when the command opens with a "/<name>"
  // token, so ordinary messages never trigger a skills probe.
  async #resolveTurnSkills(command: string, projectPath: string): Promise<CodexSkillRef[] | undefined> {
    if (!projectPath || !parseLeadingSlashCommand(command)) return undefined;
    try {
      return await getCodexSkillRefs(projectPath);
    } catch {
      return undefined;
    }
  }

  async #startRequestedTurn(
    client: CodexAppServerClient,
    session: RunningCodexSession,
    request: StartSessionRequest | ResumeTurnRequest,
  ): Promise<void> {
    if (request.codexGoalCommand) {
      if ('codexSeedContext' in request && request.codexSeedContext) {
        await client.injectThreadItems({
          threadId: session.threadId,
          items: buildInjectedContextItems(request.codexSeedContext),
        });
      }
      await this.#handleGoalCommand(client, session, request.codexGoalCommand, request, { keepSession: false });
      return;
    }

    const attachments = await writeAttachmentsToTempFiles(request.images);
    session.cleanupAttachments = attachments.cleanup;
    const skills = await this.#resolveTurnSkills(request.command, request.projectPath);
    const turn = await client.startTurn(buildTurnStartParams({
      threadId: session.threadId,
      command: request.command,
      imagePaths: attachments.imagePaths,
      filePaths: attachments.filePaths,
      model: request.model,
      projectPath: request.projectPath,
      permissionMode: request.permissionMode,
      thinkingMode: request.thinkingMode,
      clientMessageId: request.clientMessageId,
      skills,
    }));
    session.activeTurnId = turn.turn.id;

  }

  async #handleGoalCommand(
    client: CodexAppServerClient,
    session: RunningCodexSession,
    command: CodexGoalCommand,
    request: StartSessionRequest | ResumeTurnRequest,
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
            this.emitMessages(session.chatId, [new ErrorMessage(
              new Date().toISOString(),
              `An unfinished Codex goal is already ${goalStatusLabel(current.goal.status)}: ${current.goal.objective}\nUse /goal replace <objective> to replace it explicitly, or /goal clear first.`,
            )]);
            if (!keepSession) this.#finishSession(session);
            return;
          }
          const draft = await materializeGoalDraft(session.codexHome, command.objective, request.images);
          let response: ThreadGoalSetResponse;
          try {
            response = current.goal
              ? await this.#replaceThreadGoal(client, session, current.goal, draft.objective)
              : await this.#setNewThreadGoal(client, session, draft.objective);
          } catch (error) {
            await cleanupMaterializedGoalDraft(draft.outputDir);
            throw error;
          }
          session.goal = response.goal;
          await this.#waitForTurnStart(session, GOAL_TURN_START_TIMEOUT_MS);
          return;
        }
        case 'status': {
          const response = goalSynchronized
            ? { goal: session.goal }
            : await client.getThreadGoal(session.threadId);
          session.goal = response.goal;
          if (response.goal?.status === 'active') session.managesGoalLifecycle = true;
          this.emitMessages(session.chatId, [
            new AssistantMessage(new Date().toISOString(), formatGoalStatusMessage(response.goal)),
          ]);
          if (!keepSession && !hasActiveGoalContinuation(session)) this.#finishSession(session);
          return;
        }
        case 'clear': {
          const response = await client.clearThreadGoal(session.threadId);
          const message = response.cleared ? 'Codex goal cleared.' : 'No Codex goal was set.';
          this.emitMessages(session.chatId, [new AssistantMessage(new Date().toISOString(), message)]);
          if (!keepSession || !session.activeTurnId) this.#finishSession(session);
          return;
        }
        case 'pause': {
          const response = await client.setThreadGoalStatus(session.threadId, 'paused');
          session.goal = response.goal;
          this.emitMessages(session.chatId, [
            new AssistantMessage(new Date().toISOString(), formatGoalUpdatedMessage('paused', response.goal)),
          ]);
          if (!keepSession || !session.activeTurnId) this.#finishSession(session);
          return;
        }
        case 'resume': {
          const previouslyManaged = session.managesGoalLifecycle;
          const response = await client.setThreadGoalStatus(session.threadId, 'active');
          session.goal = response.goal;
          if (response.goal.status === 'active') {
            session.managesGoalLifecycle = true;
            await this.#waitForTurnStart(session, GOAL_TURN_START_TIMEOUT_MS);
          } else {
            session.managesGoalLifecycle = previouslyManaged;
            this.emitMessages(session.chatId, [
              new AssistantMessage(new Date().toISOString(), formatGoalUpdatedMessage('updated', response.goal)),
            ]);
            if (!hasActiveGoalContinuation(session)) this.#finishSession(session);
          }
          return;
        }
        case 'edit': {
          if (!command.objective) {
            this.emitMessages(session.chatId, [new ErrorMessage(
              new Date().toISOString(),
              'Usage: /goal edit <objective>',
            )]);
            if (!keepSession) this.#finishSession(session);
            return;
          }
          const current = goalSynchronized
            ? session.goal
            : (await client.getThreadGoal(session.threadId)).goal;
          if (!current) {
            this.emitMessages(session.chatId, [new ErrorMessage(
              new Date().toISOString(),
              'No Codex goal is set. Start one with /goal <objective>.',
            )]);
            if (!keepSession) this.#finishSession(session);
            return;
          }
          const status = editedGoalStatus(current.status);
          const draft = await materializeGoalDraft(session.codexHome, command.objective, request.images);
          let response: ThreadGoalSetResponse;
          const previouslyManaged = session.managesGoalLifecycle;
          try {
            if (status === 'active') session.managesGoalLifecycle = true;
            response = await client.setThreadGoal(session.threadId, {
              objective: draft.objective,
              status,
              tokenBudget: current.tokenBudget,
            });
          } catch (error) {
            await cleanupMaterializedGoalDraft(draft.outputDir);
            throw error;
          }
          session.goal = response.goal;
          if (response.goal.status === 'active') {
            await this.#waitForTurnStart(session, GOAL_TURN_START_TIMEOUT_MS);
          } else {
            session.managesGoalLifecycle = previouslyManaged;
            this.emitMessages(session.chatId, [
              new AssistantMessage(new Date().toISOString(), formatGoalUpdatedMessage('updated', response.goal)),
            ]);
            if (!keepSession || !session.activeTurnId) this.#finishSession(session);
          }
          return;
        }
        case 'unsupported':
          this.emitMessages(session.chatId, [
            new ErrorMessage(
              new Date().toISOString(),
              `Unsupported Codex goal command: /goal ${command.subcommand}. Use /goal <objective>, /goal replace <objective>, /goal edit <objective>, /goal pause, /goal resume, or /goal clear.`,
            ),
          ]);
          if (!keepSession) this.#finishSession(session);
          return;
      }
    } catch (error) {
      if (error instanceof TurnStartWaitCancelledError) {
        if (propagateDeliveryFailure) throw error;
        return;
      }
      this.emitMessages(session.chatId, [new ErrorMessage(new Date().toISOString(), humanizeCodexAppServerError(error))]);
      if (!hasActiveGoalContinuation(session)) {
        this.#finishSession(session);
      }
      if (propagateDeliveryFailure) throw error;
      return;
    }
  }

  async submitActiveInput(
    request: ResumeTurnRequest,
    beforeDelivery: () => Promise<void> = async () => {},
  ): Promise<boolean> {
    const session = this.#sessions.get(request.agentSessionId);
    if (!session || session.status === 'completed' || session.status === 'failed' || session.status === 'aborted') {
      return false;
    }
    if (!session.managesGoalLifecycle) return false;
    const operation = session.activeInputChain.then(async () => {
      if (this.#sessions.get(request.agentSessionId) !== session) return false;
      if (
        !session.managesGoalLifecycle
        || session.status === 'failed'
        || session.status === 'aborted'
        || session.status === 'completed'
        || hasTerminalPendingFinish(session)
      ) return false;
      session.activeDeliveryReservations += 1;
      try {
        await beforeDelivery();
        if (hasTerminalPendingFinish(session) || isTerminalSessionStatus(session.status)) {
          throw new Error(session.pendingFinish?.failedMessage ?? 'Codex session ended before active input delivery');
        }
        await this.#deliverReservedActiveInput(session, request);
        if (session.activeTurnId && session.pendingFinish && !session.pendingFinish.failedMessage && !session.pendingFinish.aborted) {
          session.pendingFinish = null;
        }
        return true;
      } finally {
        session.activeDeliveryReservations -= 1;
        this.#flushPendingFinish(session);
      }
    });
    session.activeInputChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #deliverReservedActiveInput(session: RunningCodexSession, request: ResumeTurnRequest): Promise<void> {
    if (request.codexGoalCommand) {
      await this.#handleGoalCommand(session.client, session, request.codexGoalCommand, request, {
        keepSession: true,
        propagateDeliveryFailure: true,
      });
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
      turnId = await this.#waitForTurnStart(session, GOAL_TURN_START_TIMEOUT_MS);
    }

    while (transitions < MAX_ACTIVE_INPUT_DELIVERY_TRANSITIONS) {
      if (this.#sessions.get(session.threadId) !== session || hasTerminalPendingFinish(session)) {
        throw new TurnStartWaitCancelledError('Codex session ended before active input delivery');
      }
      if (!turnId && session.activeTurnId) turnId = session.activeTurnId;

      if (!turnId) {
        const previousTurnId = session.activeTurnId;
        try {
          const turn = await session.client.startTurn(startParams);
          session.activeTurnId = turn.turn.id;
          return;
        } catch (error) {
          if (!isActiveTurnConflictError(error) && !isActiveTurnNotSteerableError(error)) throw error;
          turnId = await this.#waitForDifferentTurnStart(
            session,
            previousTurnId,
            GOAL_TURN_START_TIMEOUT_MS,
          );
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
        return;
      } catch (error) {
        const actualTurnId = actualTurnIdFromSteerMismatch(error);
        if (actualTurnId && actualTurnId !== turnId) {
          session.activeTurnId = actualTurnId;
          turnId = actualTurnId;
          transitions += 1;
          continue;
        }
        if (actualTurnId) throw error;
        if (isActiveTurnNotSteerableError(error)) {
          turnId = await this.#waitForDifferentTurnStart(
            session,
            turnId,
            GOAL_TURN_START_TIMEOUT_MS,
          );
          transitions += 1;
          continue;
        }
        if (isNoActiveTurnError(error)) {
          if (session.activeTurnId === turnId) session.activeTurnId = null;
          turnId = null;
          transitions += 1;
          continue;
        }
        throw error;
      }
    }
    throw new Error('Codex active input delivery exceeded the turn transition limit');
  }

  #retainAttachmentCleanup(session: RunningCodexSession, cleanup: () => Promise<void>): void {
    const previous = session.cleanupAttachments;
    session.cleanupAttachments = previous
      ? async () => { await Promise.all([previous(), cleanup()]); }
      : cleanup;
  }

  async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
    const client = this.#newClient(request, true);
    let activeSession: RunningCodexSession | null = null;

    try {
      const initialized = await client.connect();
      const started = await client.startThread(buildThreadStartParams(request));
      const threadId = started.thread.id;
      const session = this.#activateSession({
        chatId: request.chatId,
        threadId,
        nativePath: started.thread.path,
        codexHome: initialized.codexHome || null,
        client,
        permissionMode: request.permissionMode,
      });
      activeSession = session;
      session.managesGoalLifecycle = Boolean(request.codexGoalCommand);
      this.#releaseBufferedClientEvents(client);
      this.emitProcessing(request.chatId, true);
      this.emitSessionCreated(request.chatId);
      await this.#startRequestedTurn(client, session, request);

      const nativePath = await waitForMaterializedThread(started.thread, {
        timeoutMs: this.#materializationTimeoutMs,
      });
      session.nativePath = nativePath;
      this.#threadListCaches.clear();
      return { agentSessionId: threadId, nativePath };
    } catch (error) {
      const message = humanizeCodexAppServerError(error);
      if (activeSession) {
        this.#finishSession(activeSession, { failedMessage: message });
      } else {
        this.#discardBufferedClientEvents(client);
        client.shutdown();
        this.emitProcessing(request.chatId, false);
        this.emitFailed(request.chatId, message);
      }
      throw error;
    }
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    const client = this.#newClient(request, true);
    let activeSession: RunningCodexSession | null = null;

    try {
      const initialized = await client.connect();
      const resumed = await client.resumeThread(buildThreadResumeParams(request));
      const session = this.#activateSession({
        chatId: request.chatId,
        threadId: resumed.thread.id,
        nativePath: resumed.thread.path ?? request.nativePath ?? null,
        codexHome: initialized.codexHome || null,
        client,
        permissionMode: request.permissionMode,
      });
      activeSession = session;
      session.activeDeliveryReservations += 1;
      try {
        if (this.#sessions.get(session.threadId) !== session) {
          throw new Error('Codex session ended while resuming the thread');
        }
        await this.#synchronizeRestoredGoal(client, session);
        this.#releaseBufferedClientEvents(client);
        if (this.#sessions.get(session.threadId) !== session || hasTerminalPendingFinish(session)) {
          throw new TurnStartWaitCancelledError('Codex session ended while synchronizing the restored goal');
        }
        this.emitProcessing(request.chatId, true);
        if (!request.codexGoalCommand) {
          if (session.managesGoalLifecycle) {
            await this.#deliverReservedActiveInput(session, request);
          } else {
            await this.#startRequestedTurn(client, session, request);
          }
        } else {
          await this.#handleGoalCommand(
            client,
            session,
            request.codexGoalCommand,
            request,
            {
              keepSession: session.managesGoalLifecycle,
              goalSynchronized: true,
            },
          );
        }
        if (session.activeTurnId && !hasTerminalPendingFinish(session)) {
          session.pendingFinish = null;
        }
      } finally {
        session.activeDeliveryReservations -= 1;
        this.#flushPendingFinish(session);
      }
    } catch (error) {
      const message = humanizeCodexAppServerError(error);
      if (activeSession) {
        this.#discardBufferedClientEvents(client);
        this.#finishSession(activeSession, { failedMessage: message });
      } else {
        this.#discardBufferedClientEvents(client);
        client.shutdown();
        this.emitProcessing(request.chatId, false);
        this.emitFailed(request.chatId, message);
      }
      throw error;
    }
  }

  // Triggers native context compaction as its own turn. Mirrors runTurn but
  // starts the turn via thread/compact/start; the resulting contextCompaction
  // item and turn lifecycle arrive through the shared notification handlers.
  async compact(request: ResumeTurnRequest): Promise<void> {
    // A live session means a turn is already active for this thread; starting a
    // second one would overwrite the session map and leak the existing client.
    if (this.#sessions.has(request.agentSessionId)) {
      throw new Error('Cannot compact while a Codex turn is active');
    }

    const client = this.#newClient(request, true);
    let activeSession: RunningCodexSession | null = null;

    try {
      const initialized = await client.connect();
      const resumed = await client.resumeThread(buildThreadResumeParams(request));
      const session = this.#activateSession({
        chatId: request.chatId,
        threadId: resumed.thread.id,
        nativePath: resumed.thread.path ?? request.nativePath ?? null,
        codexHome: initialized.codexHome || null,
        client,
        permissionMode: request.permissionMode,
      });
      session.manualCompactionPending = true;
      activeSession = session;
      this.#releaseBufferedClientEvents(client);
      this.emitProcessing(request.chatId, true);
      await client.compactThread(resumed.thread.id);
    } catch (error) {
      const message = humanizeCodexAppServerError(error);
      if (activeSession) {
        this.#finishSession(activeSession, { failedMessage: message });
      } else {
        this.#discardBufferedClientEvents(client);
        client.shutdown();
        this.emitProcessing(request.chatId, false);
        this.emitFailed(request.chatId, message);
      }
      throw error;
    }
  }

  abort(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    if (!session) return false;
    session.status = 'aborted';
    this.#cancelTurnStartWaiters(session, 'Codex session aborted');

    const interrupt = session.activeTurnId
      ? session.client.interruptTurn(session.threadId, session.activeTurnId).catch((error: Error) => {
        logger.warn(`codex: failed to interrupt turn ${session.activeTurnId}:`, error.message);
      })
      : Promise.resolve();

    void interrupt.finally(() => {
      this.#finishSession(session, { aborted: true });
    });
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    const status = this.#sessions.get(agentSessionId)?.status;
    return status === 'running' || status === 'completing';
  }

  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#sessions.values())
      .filter((session) => session.status === 'running' || session.status === 'completing')
      .map((session) => ({ id: session.threadId, status: session.status, startedAt: session.startedAt }));
  }

  async loadMessages(session: AgentChatEntry): Promise<unknown[]> {
    return this.#loadJsonlMessages(session);
  }

  async loadMessagePage(
    session: AgentChatEntry,
    page: { limit: number; offset: number },
  ): Promise<AgentTranscriptPage | null> {
    return loadCodexChatMessagePage(session.nativePath, page.limit, page.offset);
  }

  async getPreview(session: AgentChatEntry): Promise<unknown> {
    return this.#getJsonlPreview(session);
  }

  async forkSession(args: CodexForkSessionRequest): Promise<StartedAgentSession | null> {
    const sourceSession = args.sourceSession;
    const sourceThreadId = sourceSession.agentSessionId;
    if (!sourceThreadId) return null;

    return this.#withOperationClient(args, async (client) => {
      const forked = await client.forkThread(buildThreadForkParams({
        agentSessionId: sourceThreadId,
        nativePath: sourceSession.nativePath,
        model: sourceSession.model,
        projectPath: sourceSession.projectPath,
        codexConfig: args.codexConfig,
      }));
      await this.#unsubscribeBestEffort(client, forked.thread.id);
      const nativePath = await waitForMaterializedThread(forked.thread, {
        timeoutMs: this.#materializationTimeoutMs,
      });
      this.#threadListCaches.clear();
      return { agentSessionId: forked.thread.id, nativePath };
    });
  }

  async resolveNativePath(session: AgentChatEntry): Promise<string | null> {
    if (!session.agentSessionId) return null;

    const threads = await this.#getThreadListCache(false);
    const nativePath = threads?.get(session.agentSessionId)?.path ?? null;
    if (!nativePath) return null;

    try {
      await fs.access(nativePath);
      return nativePath;
    } catch {
      return null;
    }
  }

  async resolvePermission(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): Promise<void> {
    const pending = this.#pendingApprovals.get(permissionRequestId);
    if (!pending) {
      logger.warn('codex: resolvePermission, no pending entry for', permissionRequestId);
      return;
    }

    this.#pendingApprovals.delete(permissionRequestId);
    pending.client.respond(pending.requestId, buildApprovalResponse(pending, decision));
    this.emitMessages(pending.chatId, [
      new PermissionResolvedMessage(new Date().toISOString(), permissionRequestId, Boolean(decision.allow)),
    ]);
  }

  updateSessionSettings(agentSessionId: string, patch: AgentSessionSettingsPatch): void {
    const session = this.#sessions.get(agentSessionId);
    if (!session) return;
    if (patch.permissionMode !== undefined) session.permissionMode = patch.permissionMode;
  }

  startPurgeTimer(): void {
    this.#idlePurger.start();
  }

  shutdown(): void {
    this.#idlePurger.stop();
    for (const session of this.#sessions.values()) {
      this.#cancelTurnStartWaiters(session, 'Codex runtime shut down');
      void session.cleanupAttachments?.();
      session.client.shutdown();
    }
    this.#sessions.clear();
    this.#utilityClient?.shutdown();
    this.#utilityClient = null;
    this.#utilityQueue = Promise.resolve();
    this.#threadListCaches.clear();
    this.#bufferingClients.clear();
    this.#bufferedClientEvents.clear();
  }

  #newClient(
    request: Pick<StartSessionRequest, 'envOverrides' | 'codexConfig'>,
    bufferNotifications = false,
  ): CodexAppServerClient {
    const client = this.#createClient({ env: buildCodexEnv(request.envOverrides, request.codexConfig) });
    if (bufferNotifications) this.#bufferingClients.add(client);
    this.#wireClient(client);
    return client;
  }

  async #withOperationClient<T>(
    request: Pick<StartSessionRequest, 'envOverrides' | 'codexConfig'>,
    operation: (client: CodexAppServerClient) => Promise<T>,
  ): Promise<T> {
    const client = this.#newClient(request);
    try {
      return await operation(client);
    } finally {
      client.shutdown();
    }
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

    void this.#sampleUtilityLoadedThreads();
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

  async #sampleUtilityLoadedThreads(): Promise<void> {
    const client = this.#utilityClient;
    if (!client) return;
    try {
      const response = await client.loadedThreads();
      const metric: CodexAppServerMetric = {
        name: 'codex.app_server.loaded_threads',
        loadedThreadCount: response.data.length,
      };
      this.emit('metric', metric);
    } catch (error) {
      logger.warn('codex: failed to sample loaded app-server threads:', (error as Error).message);
    }
  }

  async #unsubscribeBestEffort(client: CodexAppServerClient, threadId: string): Promise<void> {
    try {
      await client.unsubscribeThread(threadId);
    } catch (error) {
      logger.warn(`codex: failed to unsubscribe app-server thread ${threadId}:`, (error as Error).message);
    }
  }

  #activateSession(args: {
    chatId: string;
    threadId: string;
    nativePath: string | null;
    codexHome: string | null;
    client: CodexAppServerClient;
    permissionMode: PermissionMode;
  }): RunningCodexSession {
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
      activeDeliveryReservations: 0,
      pendingFinish: null,
      liveCodeModeCallIds: new Set(),
      capacityRetryCount: 0,
      pendingCapacityFailure: null,
    };
    this.#sessions.set(args.threadId, session);
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
    client.on('stderr', (line: string) => logger.warn('codex app-server:', line));
    client.on('warning', (message: string) => logger.warn(message));
    client.on('metric', (metric: unknown) => this.emit('metric', metric));
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
      case 'error':
        this.#handleErrorNotification(client, notification.params as ErrorNotification);
        break;
    }
  }

  #handleTurnStarted(client: CodexAppServerClient, params: TurnStartedNotification): void {
    const session = this.#sessionForClientThread(client, params.threadId);
    if (!session) return;
    session.activeTurnId = params.turn.id;
    session.status = 'running';
    for (const waiter of session.turnStartWaiters) waiter.resolve(params.turn.id);
  }

  #handleGoalUpdated(client: CodexAppServerClient, params: ThreadGoalUpdatedNotification): void {
    const session = this.#sessionForClientThread(client, params.threadId);
    if (!session) return;
    session.goal = params.goal;
    if (params.goal.status === 'active') session.managesGoalLifecycle = true;
    if (
      session.managesGoalLifecycle
      && params.goal.status !== 'active'
      && session.completedGoalTurn
      && !session.activeTurnId
    ) {
      this.#finishSession(session);
    }
  }

  #handleGoalCleared(client: CodexAppServerClient, params: ThreadGoalClearedNotification): void {
    const session = this.#sessionForClientThread(client, params.threadId);
    if (!session) return;
    if (session.ignoredGoalClears > 0) {
      session.ignoredGoalClears -= 1;
      return;
    }
    session.goal = null;
    if (session.managesGoalLifecycle && !session.activeTurnId) this.#finishSession(session);
  }

  async #clearGoalForReplacement(client: CodexAppServerClient, session: RunningCodexSession): Promise<boolean> {
    session.ignoredGoalClears += 1;
    const response = await client.clearThreadGoal(session.threadId);
    if (!response.cleared) this.#releaseIgnoredGoalClear(session);
    return response.cleared;
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
      cleared = await this.#clearGoalForReplacement(client, session);
    } catch (clearError) {
      let reconciled = false;
      let clearCommitted = false;
      try {
        session.goal = (await client.getThreadGoal(session.threadId)).goal;
        reconciled = true;
        clearCommitted = !session.goal;
      } catch (reconcileError) {
        logger.warn('codex: failed to reconcile goal after replacement clear failure:', (reconcileError as Error).message);
      }
      if (clearCommitted) {
        try {
          session.goal = (await client.setThreadGoal(session.threadId, {
            objective: previousGoal.objective,
            status: previousGoal.status,
            tokenBudget: previousGoal.tokenBudget,
          })).goal;
        } catch (rollbackError) {
          logger.warn('codex: failed to restore goal after replacement clear failure:', (rollbackError as Error).message);
        }
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
          logger.warn('codex: failed to restore goal after replacement failure:', (rollbackError as Error).message);
        }
      }
      try {
        session.goal = (await client.getThreadGoal(session.threadId)).goal;
      } catch (reconcileError) {
        session.goal = null;
        logger.warn('codex: failed to reconcile goal after replacement failure:', (reconcileError as Error).message);
      }
      session.managesGoalLifecycle = previouslyManaged || session.goal?.status === 'active';
      throw replacementError;
    }
  }

  #releaseIgnoredGoalClear(session: RunningCodexSession): void {
    if (session.ignoredGoalClears > 0) session.ignoredGoalClears -= 1;
  }

  #handleItemCompleted(client: CodexAppServerClient, params: ItemCompletedNotification): void {
    const session = this.#sessionForClientTurn(client, params.threadId, params.turnId);
    if (!session) return;
    // A contextCompaction item is 'manual' only when this session was started by
    // /compact; otherwise the app-server auto-compacted to free context.
    let compactionTrigger: CompactionTrigger | undefined;
    if (params.item.type === 'contextCompaction') {
      compactionTrigger = session.manualCompactionPending ? 'manual' : 'auto';
      session.manualCompactionPending = false;
    }
    const messages = convertCodexAppServerLiveItem(params.item, undefined, compactionTrigger);
    if (messages.length) this.emitMessages(session.chatId, messages);
  }

  #handleRawResponseItemCompleted(client: CodexAppServerClient, params: RawResponseItemCompletedNotification): void {
    const session = this.#sessionForClientTurn(client, params.threadId, params.turnId);
    if (!session) return;
    const messages = convertCodexRawCodeModeItem(
      params.item,
      new Date().toISOString(),
      session.liveCodeModeCallIds,
    );
    if (messages.length) this.emitMessages(session.chatId, messages);
  }

  #handleTurnCompleted(client: CodexAppServerClient, params: TurnCompletedNotification): void {
    const session = this.#sessionForClientTurn(client, params.threadId, params.turn.id);
    if (!session) return;
    void this.#completeTurn(session, params).catch((error) => {
      if (
        this.#sessions.get(session.threadId) !== session
        || isTerminalSessionStatus(session.status)
        || hasTerminalPendingFinish(session)
      ) return;
      this.#finishSession(session, { failedMessage: humanizeCodexAppServerError(error) });
    });
  }

  async #completeTurn(session: RunningCodexSession, params: TurnCompletedNotification): Promise<void> {
    session.liveCodeModeCallIds.clear();
    if (params.turn.status === 'failed') {
      if (session.managesGoalLifecycle && session.goal && session.goal.status !== 'active') {
        session.activeTurnId = null;
        session.completedGoalTurn = true;
        this.#finishSession(session);
        return;
      }
      const pendingCapacityFailure = session.pendingCapacityFailure?.turnId === params.turn.id
        ? session.pendingCapacityFailure
        : null;
      session.pendingCapacityFailure = null;
      const failedMessage = pendingCapacityFailure?.message
        ?? params.turn.error?.message
        ?? 'Codex turn failed';
      if ((pendingCapacityFailure || isCapacityError(params.turn.error)) && await this.#retryCapacityFailure(session)) {
        return;
      }
      this.#finishSession(session, { failedMessage });
      return;
    }
    const aborted = params.turn.status === 'interrupted' || session.status === 'aborted';
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
    this.#finishSession(session, { aborted });
  }

  #handleErrorNotification(client: CodexAppServerClient, params: ErrorNotification): void {
    const session = this.#sessionForClientTurn(client, params.threadId, params.turnId);
    if (!session) return;
    const message = params.error.message || params.error.additionalDetails || 'Codex app-server error';
    this.emitMessages(session.chatId, [new ErrorMessage(new Date().toISOString(), message)]);
    if (params.willRetry) return;
    if (isCapacityError(params.error)) {
      session.pendingCapacityFailure = { turnId: params.turnId, message };
      return;
    }
    this.#finishSession(session, { failedMessage: message });
  }

  async #retryCapacityFailure(session: RunningCodexSession): Promise<boolean> {
    const delayMs = this.#capacityRetryDelaysMs[session.capacityRetryCount];
    if (delayMs === undefined) return false;

    session.capacityRetryCount += 1;
    session.activeTurnId = null;
    session.status = 'running';
    await delay(delayMs);
    if (this.#sessions.get(session.threadId) !== session || session.status !== 'running') return true;

    const turn = await session.client.startTurn({
      threadId: session.threadId,
      input: [],
    });
    if (this.#sessions.get(session.threadId) !== session || session.status !== 'running') return true;
    session.activeTurnId = turn.turn.id;
    return true;
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
    const session = threadId ? this.#sessions.get(threadId) : this.#sessionForClient(client);
    if (!session) {
      client.respond(request.id, denialResponseForRequest(request.method));
      return;
    }

    const pending = { ...createPendingApproval(session.chatId, request), client };
    if (session.permissionMode === 'manualBypass') {
      client.respond(request.id, buildApprovalResponse(pending, { allow: true, alwaysAllow: false }));
      return;
    }
    this.#pendingApprovals.set(pending.permissionRequestId, pending);
    this.emitMessages(session.chatId, [buildApprovalMessage(pending)]);
  }

  #handleClientExit(client: CodexAppServerClient, code: number): void {
    const session = this.#sessionForClient(client);
    if (!session || (session.status !== 'running' && session.status !== 'completing')) return;
    this.#finishSession(session, { failedMessage: `Codex app-server exited with code ${code}` });
  }

  #finishSession(session: RunningCodexSession, opts: FinishSessionOptions = {}): void {
    if (!this.#sessions.has(session.threadId)) return;
    this.#cancelTurnStartWaiters(session, 'Codex session finished');
    if (session.activeDeliveryReservations > 0) {
      session.pendingFinish = mergeFinishOptions(session.pendingFinish, opts);
      return;
    }

    this.#sessions.delete(session.threadId);
    this.#threadListCaches.clear();
    session.status = opts.failedMessage ? 'failed' : opts.aborted ? 'aborted' : 'completed';
    this.#cancelPendingApprovals(session.chatId, opts.aborted ? 'aborted' : 'session-complete');
    this.emitProcessing(session.chatId, false);
    void session.cleanupAttachments?.();

    if (opts.failedMessage) {
      this.emitFailed(session.chatId, opts.failedMessage);
    } else if (!opts.aborted) {
      this.emitFinished(session.chatId);
    }

    session.client.shutdown();
  }

  #flushPendingFinish(session: RunningCodexSession): void {
    if (session.activeDeliveryReservations > 0 || !session.pendingFinish) return;
    const pending = session.pendingFinish;
    session.pendingFinish = null;
    this.#finishSession(session, pending);
  }

  #waitForTurnStart(session: RunningCodexSession, timeoutMs: number): Promise<string> {
    if (session.activeTurnId) return Promise.resolve(session.activeTurnId);
    return this.#registerTurnStartWaiter(
      session,
      timeoutMs,
      () => true,
      `timed out waiting for Codex goal turn to start after ${Math.round(timeoutMs / 1000)} seconds`,
    );
  }

  #waitForDifferentTurnStart(
    session: RunningCodexSession,
    previousTurnId: string | null,
    timeoutMs: number,
  ): Promise<string> {
    if (session.activeTurnId && session.activeTurnId !== previousTurnId) {
      return Promise.resolve(session.activeTurnId);
    }
    return this.#registerTurnStartWaiter(
      session,
      timeoutMs,
      (turnId) => turnId !== previousTurnId,
      `timed out waiting for the next Codex turn after ${Math.round(timeoutMs / 1000)} seconds`,
    );
  }

  #registerTurnStartWaiter(
    session: RunningCodexSession,
    timeoutMs: number,
    accepts: (turnId: string) => boolean,
    timeoutMessage: string,
  ): Promise<string> {
    if (this.#sessions.get(session.threadId) !== session) {
      return Promise.reject(new TurnStartWaitCancelledError('Codex session is no longer active'));
    }
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const settle = (action: () => void) => {
        clearTimeout(timeout);
        session.turnStartWaiters.delete(waiter);
        action();
      };
      const waiter: TurnStartWaiter = {
        resolve: (turnId) => {
          if (accepts(turnId)) settle(() => resolve(turnId));
        },
        reject: (error) => settle(() => reject(error)),
      };
      timeout = setTimeout(() => waiter.reject(new Error(timeoutMessage)), timeoutMs);
      session.turnStartWaiters.add(waiter);
    });
  }

  #cancelTurnStartWaiters(session: RunningCodexSession, message: string): void {
    const error = new TurnStartWaitCancelledError(message);
    for (const waiter of [...session.turnStartWaiters]) waiter.reject(error);
  }

  #cancelPendingApprovals(chatId: string, reason: 'cancelled' | 'session-complete' | 'aborted'): void {
    const messages: PermissionCancelledMessage[] = [];
    for (const [permissionRequestId, pending] of this.#pendingApprovals.entries()) {
      if (pending.chatId !== chatId) continue;
      this.#pendingApprovals.delete(permissionRequestId);
      messages.push(new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, reason));
    }
    this.emitMessages(chatId, messages);
  }

  #sessionForClientThread(client: CodexAppServerClient, threadId: string): RunningCodexSession | null {
    const session = this.#sessions.get(threadId);
    return session?.client === client ? session : null;
  }

  #sessionForClientTurn(
    client: CodexAppServerClient,
    threadId: string,
    turnId: string,
  ): RunningCodexSession | null {
    const session = this.#sessionForClientThread(client, threadId);
    return session?.activeTurnId === turnId ? session : null;
  }

  #sessionForClient(client: CodexAppServerClient): RunningCodexSession | null {
    for (const session of this.#sessions.values()) {
      if (session.client === client) return session;
    }
    return null;
  }

  #loadJsonlMessages(session: AgentChatEntry): Promise<ChatMessage[]> {
    // Codex app-server `thread/read` also reads rollout JSONL, but projects it
    // through a lossy app-server view that drops raw function_call/tool rows.
    // Garcon uses the native JSONL transcript as the display source of record.
    return loadCodexChatMessages(session.nativePath);
  }

  #getJsonlPreview(session: AgentChatEntry): Promise<unknown> {
    return getCodexPreviewFromNativePath(session.nativePath);
  }
}

function denialResponseForRequest(method: string): unknown {
  if (method === 'item/commandExecution/requestApproval') return { decision: 'decline' };
  if (method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  return { decision: 'denied' };
}

function humanizeCodexAppServerError(error: unknown): string {
  const raw = String((error as Error)?.message || error || '');
  if (/not found|ENOENT.*codex|spawn codex/i.test(raw)) {
    return 'Codex CLI is not installed or not in PATH. Install it with: npm i -g @openai/codex';
  }
  if (/authentication|unauthorized|401|api.?key/i.test(raw)) {
    return 'Codex authentication failed. Run "codex" in your terminal to sign in.';
  }
  if (/rate.?limit|429/i.test(raw)) {
    return 'Codex rate limit exceeded. Please wait a moment and try again.';
  }
  if (/model.*not.?found|invalid.*model|does not exist/i.test(raw)) {
    return 'Codex model not available. Check your model selection or Codex configuration.';
  }
  if (/ECONNREFUSED|ENOTFOUND|network|timeout|ETIMEDOUT/i.test(raw)) {
    return 'Codex could not connect to the API. Check your network connection.';
  }
  return `Codex error: ${raw}`;
}

function goalStatusLabel(status: CodexThreadGoalStatus): string {
  switch (status) {
    case 'active': return 'active';
    case 'paused': return 'paused';
    case 'blocked': return 'blocked';
    case 'usageLimited': return 'usage limited';
    case 'budgetLimited': return 'limited by budget';
    case 'complete': return 'complete';
  }
}

function formatGoalStatusMessage(goal: CodexThreadGoal | null): string {
  if (!goal) return 'No Codex goal is set.';
  const lines = [
    'Goal',
    `Status: ${goalStatusLabel(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Time used: ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}`,
    `Tokens used: ${formatGoalTokens(goal.tokensUsed)}`,
  ];
  if (goal.tokenBudget !== null) lines.push(`Token budget: ${formatGoalTokens(goal.tokenBudget)}`);
  lines.push('', goalCommandHint(goal.status));
  return lines.join('\n');
}

function formatGoalUpdatedMessage(action: string, goal: CodexThreadGoal): string {
  return [
    `Codex goal ${action}.`,
    `Objective: ${goal.objective}`,
    formatGoalUsageMessage(goal),
  ].filter(Boolean).join('\n');
}

function formatGoalUsageMessage(goal: CodexThreadGoal): string {
  const budget = goal.tokenBudget === null ? '' : `/${formatGoalTokens(goal.tokenBudget)}`;
  return `Usage: time ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}, tokens ${formatGoalTokens(goal.tokensUsed)}${budget}.`;
}

function formatGoalElapsedSeconds(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  const minutes = Math.floor(safeSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function formatGoalTokens(tokens: number): string {
  const safeTokens = Math.max(0, Math.floor(tokens));
  if (safeTokens < 1_000) return String(safeTokens);
  const divisor = safeTokens >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = divisor === 1_000_000 ? 'M' : 'K';
  const compact = safeTokens / divisor;
  return `${Number.isInteger(compact) ? compact : compact.toFixed(1)}${suffix}`;
}

function goalCommandHint(status: CodexThreadGoalStatus): string {
  switch (status) {
    case 'active':
      return 'Commands: /goal edit <objective>, /goal pause, /goal clear';
    case 'paused':
    case 'blocked':
    case 'usageLimited':
      return 'Commands: /goal edit <objective>, /goal resume, /goal clear';
    case 'budgetLimited':
    case 'complete':
      return 'Commands: /goal edit <objective>, /goal clear';
  }
}

function editedGoalStatus(status: CodexThreadGoalStatus): CodexThreadGoalStatus {
  return status === 'budgetLimited' || status === 'complete' ? 'active' : status;
}

function isUtilityOverload(error: unknown): boolean {
  if (error instanceof CodexAppServerRpcError && error.code === -32001) return true;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (record.code === -32001) return true;
  return /overloaded/i.test(String((error as Error)?.message || error || ''));
}

function isCapacityError(error: CodexTurnError | null | undefined): boolean {
  return error?.codexErrorInfo === 'serverOverloaded'
    || /selected model is at capacity/i.test(error?.message ?? '');
}

function isNoActiveTurnError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '');
  return /no active turn|expected turn.*(?:not active|mismatch|active turn)|active turn.*not found/i.test(message);
}

function isActiveTurnNotSteerableError(error: unknown): boolean {
  if (error instanceof CodexAppServerRpcError) {
    const data = error.data && typeof error.data === 'object'
      ? error.data as Record<string, unknown>
      : null;
    const codexErrorInfo = data?.codexErrorInfo;
    if (codexErrorInfo && typeof codexErrorInfo === 'object' && 'activeTurnNotSteerable' in codexErrorInfo) {
      return true;
    }
  }
  const message = String((error as Error)?.message || error || '');
  return /cannot steer (?:a )?(?:review|compact) turn/i.test(message);
}

function actualTurnIdFromSteerMismatch(error: unknown): string | null {
  const message = String((error as Error)?.message || error || '');
  const match = /^expected active turn id `[^`]+` but found `([^`]+)`$/.exec(message);
  return match?.[1] ?? null;
}

function isActiveTurnConflictError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '');
  return /turn already active|active turn.*(?:exists|in progress)|cannot start.*active turn/i.test(message);
}

function mergeFinishOptions(
  current: FinishSessionOptions | null,
  next: FinishSessionOptions,
): FinishSessionOptions {
  return {
    failedMessage: next.failedMessage ?? current?.failedMessage,
    aborted: Boolean(next.aborted || current?.aborted),
  };
}

function hasTerminalPendingFinish(session: RunningCodexSession): boolean {
  return Boolean(session.pendingFinish?.failedMessage || session.pendingFinish?.aborted);
}

function isTerminalSessionStatus(status: RunningStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}

function hasActiveGoalContinuation(session: RunningCodexSession): boolean {
  return session.managesGoalLifecycle
    && Boolean(session.activeTurnId || session.goal?.status === 'active');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
