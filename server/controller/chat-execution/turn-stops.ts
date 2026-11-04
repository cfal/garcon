import type { ChatStopIntent, ChatStopOutcome } from '../../../common/chat-types.js';
import { createLogger } from '../../common/log.js';
import type { AutomationControlLease, AutomationLifecycle } from '../automation/lifecycle.js';
import type { QueueExecutionAttempt } from './execution-attempt.js';
import type { ExecutionOwnership } from './execution-ownership.js';
import type { AgentTurnRunnerPort, SessionStoppedCallback } from './types.js';

const logger = createLogger('queue:stop');

interface TurnStopsOptions {
  readonly ownership: ExecutionOwnership;
  readonly automation: AutomationLifecycle;
  readonly runner: AgentTurnRunnerPort;
  readonly retireAttempt: (chatId: string, attempt: QueueExecutionAttempt, reason: Error) => void;
  readonly stopped: SessionStoppedCallback;
  readonly invalidateProcessing: (chatId: string) => void;
  readonly rearmDrain: (chatId: string) => void;
}

export class TurnStops {
  readonly #tasks = new Map<string, Promise<ChatStopOutcome>>();
  readonly #exact = new Map<QueueExecutionAttempt, Promise<ChatStopOutcome | 'stale-target'>>();

  constructor(private readonly options: TurnStopsOptions) {}

  isStopping(chatId: string): boolean { return this.#tasks.has(chatId); }

  request(chatId: string, intent: ChatStopIntent): Promise<ChatStopOutcome> {
    const existing = this.#tasks.get(chatId);
    if (existing) return existing;
    const interruptedTurn = this.options.ownership.attempt(chatId)?.identity();
    const task = this.#perform(chatId).then(outcome => {
      this.options.stopped(chatId, outcome, intent, interruptedTurn);
      return outcome;
    }).finally(() => {
      if (this.#tasks.get(chatId) === task) this.#tasks.delete(chatId);
      this.options.invalidateProcessing(chatId);
    });
    this.#tasks.set(chatId, task);
    return task;
  }

  exact(lease: AutomationControlLease): Promise<ChatStopOutcome | 'stale-target'> {
    const { ownership, automation } = this.options;
    const { chatId, turnId, clientRequestId } = lease.key;
    const attempt = ownership.attempt(chatId);
    if (!automation.ownsControl(lease) || (attempt && !attempt.matches({ turnId, clientRequestId })) || this.#tasks.has(chatId)) {
      return Promise.resolve('stale-target');
    }
    if (!attempt) return Promise.resolve('already-idle');
    const existing = this.#exact.get(attempt);
    if (existing) return existing;
    if (attempt.hasTerminalCommit) return Promise.resolve('already-idle');
    ownership.enterManualStop(chatId);
    ownership.enterAbortSuppression(chatId);
    const task = this.#performExact(chatId, attempt, lease).finally(() => {
      this.#exact.delete(attempt);
      ownership.clearAbortSuppression(chatId);
      ownership.exitManualStop(chatId, { drainStillActive: ownership.isDraining(chatId) });
      this.options.rearmDrain(chatId);
    });
    this.#exact.set(attempt, task);
    return task;
  }

  async #performExact(chatId: string, attempt: QueueExecutionAttempt, lease: AutomationControlLease): Promise<ChatStopOutcome | 'stale-target'> {
    const { ownership, automation } = this.options;
    // No await separates the captured-attempt fence from abort delivery.
    if (!automation.ownsControl(lease) || !ownership.isCurrentAttempt(chatId, attempt)) return 'stale-target';
    const interruption = new Error('Turn interrupted by automation');
    ownership.abortAdmission(chatId, interruption);
    if (!automation.ownsControl(lease) || !ownership.isCurrentAttempt(chatId, attempt)) return 'failed';
    if (attempt.hasTerminalCommit) return 'already-idle';
    let outcome: ChatStopOutcome;
    try {
      await this.options.runner.abortSession(chatId);
      if (ownership.isCurrentAttempt(chatId, attempt)) this.options.retireAttempt(chatId, attempt, interruption);
      outcome = 'interrupt-requested';
    } catch (error) {
      logger.warn('Exact-turn interrupt failed', { chatId, errorType: error instanceof Error ? error.name : typeof error });
      outcome = 'failed';
    }
    this.options.stopped(chatId, outcome, 'stop', attempt.identity());
    return outcome;
  }

  async #perform(chatId: string): Promise<ChatStopOutcome> {
    const { ownership } = this.options;
    const attempt = ownership.attempt(chatId);
    if (attempt?.hasTerminalCommit) return 'already-idle';
    const interruption = new Error('Turn interrupted by the user');
    if (attempt) ownership.abortAdmission(chatId, interruption);
    try {
      const acknowledged = await this.options.runner.abortSession(chatId);
      if (!acknowledged && !attempt) return 'already-idle';
      if (attempt && ownership.isCurrentAttempt(chatId, attempt)) {
        this.options.retireAttempt(chatId, attempt, interruption);
      }
      return 'interrupt-requested';
    } catch (error) {
      logger.warn('Provider interrupt failed', { chatId, errorType: error instanceof Error ? error.name : typeof error });
      return 'failed';
    }
  }
}
