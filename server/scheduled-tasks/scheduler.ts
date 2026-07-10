import crypto from 'crypto';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import {
  normalizeScheduledTaskDefinitionInput,
  type CreateScheduledTaskRequest,
  type ReorderScheduledTasksRequest,
  type RemoveScheduledTaskRequest,
  type ScheduledTask,
  type ScheduledTaskDefinitionInput,
  type ScheduledTasksInvalidationReason,
  type ScheduledTasksSnapshot,
  type UpdateScheduledTaskRequest,
} from '../../common/scheduled-tasks.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { IChatRegistry } from '../chats/store.js';
import { errorMessage } from '../lib/errors.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import { createLogger } from '../lib/log.js';
import type { ScheduledTaskDispatcher } from './dispatcher.js';
import { ScheduledTaskRunLog } from './run-log.js';
import { ScheduledTaskDomainError, ScheduledTaskStore } from './store.js';

const logger = createLogger('scheduled-tasks');
const SCHEDULER_LOCK = 'scheduled-tasks-scheduler';

export interface CronRuntime {
  schedule(expression: string, handler: (this: Bun.CronJob) => unknown): Bun.CronJob;
}

export const bunCronRuntime: CronRuntime = {
  schedule: (expression, handler) => Bun.cron(expression, handler),
};

export function cronExpressionForUtcInstant(iso: string): string {
  const value = new Date(iso);
  return [value.getUTCMinutes(), value.getUTCHours(), value.getUTCDate(), value.getUTCMonth() + 1, '*'].join(' ');
}

function sameUtcMinute(left: number, right: number): boolean {
  return Math.floor(left / 60_000) === Math.floor(right / 60_000);
}

function nextMinute(now: Date): number {
  return Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
}

export class ScheduledTaskScheduler extends EventEmitter {
  readonly #jobs = new Map<string, Bun.CronJob>();
  readonly #lock = new KeyedPromiseLock();
  #reconciliationJob: Bun.CronJob | null = null;
  #stopped = false;

  constructor(
    private readonly deps: {
      store: ScheduledTaskStore;
      runLog: ScheduledTaskRunLog;
      dispatcher: ScheduledTaskDispatcher;
      chats: Pick<IChatRegistry, 'getChat'>;
      agents: Pick<AgentRegistryServiceContract, 'hasAgent'>;
      cron?: CronRuntime;
    },
  ) {
    super();
  }

  onInvalidated(callback: (reason: ScheduledTasksInvalidationReason) => void): void {
    this.on('invalidated', callback);
  }

  async start(now = new Date()): Promise<void> {
    await this.deps.store.init();
    await this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      this.#stopped = false;
      await this.#reconcileMissed(now, true);
      this.#rebuildJobs();
      const scheduler = this;
      this.#reconciliationJob = this.#cron.schedule('@hourly', async function () {
        try {
          await scheduler.#lock.runExclusive(SCHEDULER_LOCK, async () => {
            await scheduler.#reconcileMissed(new Date(), false);
          });
        } catch (error) {
          logger.error('hourly reconciliation failed:', errorMessage(error));
          scheduler.#appendLog(`Task reconciliation failed: ${errorMessage(error)}.`);
        }
      });
    });
    logger.info(`registered ${this.#jobs.size} scheduled task(s)`);
  }

  stop(): void {
    this.#stopped = true;
    this.#reconciliationJob?.stop();
    this.#reconciliationJob = null;
    for (const job of this.#jobs.values()) job.stop();
    this.#jobs.clear();
  }

  async snapshotAfterReconciliation(): Promise<ScheduledTasksSnapshot> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      await this.#reconcileMissed(new Date(), false);
      return this.#snapshot();
    });
  }

  async create(request: CreateScheduledTaskRequest): Promise<ScheduledTasksSnapshot> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      await this.#reconcileMissed(new Date(), false);
      const definition = await this.#validateDefinition(request.task);
      const now = new Date();
      const task = this.#taskFromDefinition(crypto.randomUUID(), definition, now);
      await this.deps.store.create(task, request.expectedRevision);
      try {
        this.#register(task);
      } catch (error) {
        await this.deps.store.remove(task.id, this.deps.store.revision).catch(() => {});
        throw error;
      }
      this.#emitInvalidated('created');
      return this.#snapshot();
    });
  }

  async update(request: UpdateScheduledTaskRequest): Promise<ScheduledTasksSnapshot> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      await this.#reconcileMissed(new Date(), false);
      const previous = this.deps.store.get(request.id);
      if (!previous) {
        throw new ScheduledTaskDomainError('SCHEDULED_TASK_NOT_FOUND', 'Scheduled task not found', 404);
      }
      const definition = await this.#validateDefinition(request.task);
      const replacement = this.#taskFromDefinition(request.id, definition, new Date(), previous.createdAt);
      await this.deps.store.replace(replacement, request.expectedRevision);
      this.#jobs.get(request.id)?.stop();
      this.#jobs.delete(request.id);
      try {
        this.#register(replacement);
      } catch (error) {
        await this.deps.store.restore(previous);
        this.#register(previous);
        throw error;
      }
      this.#emitInvalidated('updated');
      return this.#snapshot();
    });
  }

  async remove(request: RemoveScheduledTaskRequest): Promise<ScheduledTasksSnapshot> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      await this.#reconcileMissed(new Date(), false);
      await this.deps.store.remove(request.id.trim(), request.expectedRevision);
      this.#jobs.get(request.id)?.stop();
      this.#jobs.delete(request.id);
      this.#emitInvalidated('removed');
      return this.#snapshot();
    });
  }

  async reorder(request: ReorderScheduledTasksRequest): Promise<ScheduledTasksSnapshot> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      await this.#reconcileMissed(new Date(), false);
      await this.deps.store.reorder(request.orderedTaskIds, request.expectedRevision);
      this.#emitInvalidated('reordered');
      return this.#snapshot();
    });
  }

  async #validateDefinition(value: unknown): Promise<ScheduledTaskDefinitionInput> {
    const definition = normalizeScheduledTaskDefinitionInput(value);
    if (!definition) {
      throw new ScheduledTaskDomainError('SCHEDULED_TASK_VALIDATION_FAILED', 'Scheduled task is invalid', 400);
    }
    const firstRunAt =
      definition.schedule.type === 'once' ? definition.schedule.runAtUtc : definition.schedule.firstRunAtUtc;
    if (Date.parse(firstRunAt) < nextMinute(new Date())) {
      throw new ScheduledTaskDomainError(
        'SCHEDULED_TASK_VALIDATION_FAILED',
        'The first run must be at least the next minute',
        400,
      );
    }
    if (definition.target.type === 'existing-chat') {
      if (!this.deps.chats.getChat(definition.target.chatId)) {
        throw new ScheduledTaskDomainError('SESSION_NOT_FOUND', 'Selected chat was not found', 404);
      }
      return definition;
    }
    if (!this.deps.agents.hasAgent(definition.target.agentId)) {
      throw new ScheduledTaskDomainError('UNSUPPORTED_AGENT', `Unsupported agent: ${definition.target.agentId}`, 422);
    }
    try {
      const resolved = await assertRealWithinProjectBase(definition.target.projectPath);
      if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Project path is not a directory');
    } catch (error) {
      if (isProjectBoundaryError(error)) {
        throw new ScheduledTaskDomainError(
          'PROJECT_PATH_OUTSIDE_BASE',
          'Project path is outside the allowed base directory',
          403,
        );
      }
      throw new ScheduledTaskDomainError('PROJECT_PATH_NOT_FOUND', 'Project path was not found', 404);
    }
    return definition;
  }

  #taskFromDefinition(
    id: string,
    definition: ScheduledTaskDefinitionInput,
    now: Date,
    createdAt = now.toISOString(),
  ): ScheduledTask {
    return {
      id,
      schedule:
        definition.schedule.type === 'once'
          ? { type: 'once', nextRunAt: definition.schedule.runAtUtc }
          : {
              type: 'recurring',
              intervalDays: definition.schedule.intervalDays,
              nextRunAt: definition.schedule.firstRunAtUtc,
              endAt: definition.schedule.endAtUtc,
            },
      target: structuredClone(definition.target),
      prompt: definition.prompt,
      createdAt,
      updatedAt: now.toISOString(),
    };
  }

  #register(task: ScheduledTask): void {
    if (this.#stopped) return;
    this.#jobs.get(task.id)?.stop();
    const expectedRunAt = task.schedule.nextRunAt;
    const expectedMs = Date.parse(expectedRunAt);
    const scheduler = this;
    const job = this.#cron.schedule(cronExpressionForUtcInstant(expectedRunAt), async function () {
      try {
        if (scheduler.#jobs.get(task.id) !== this) {
          this.stop();
          return;
        }
        const now = Date.now();
        if (now < expectedMs) return;
        this.stop();
        scheduler.#jobs.delete(task.id);
        if (!sameUtcMinute(now, expectedMs)) {
          await scheduler.#lock.runExclusive(SCHEDULER_LOCK, async () => {
            await scheduler.#reconcileMissed(new Date(now), false);
          });
          return;
        }
        const claim = await scheduler.#lock.runExclusive(SCHEDULER_LOCK, async () => {
          const claimed = await scheduler.deps.store.claimOccurrence(task.id, expectedRunAt);
          if (claimed?.nextTask) scheduler.#register(claimed.nextTask);
          return claimed;
        });
        if (!claim) return;
        try {
          const outcome = await scheduler.deps.dispatcher.dispatch(claim.task, expectedRunAt);
          scheduler.#appendLog(outcome.message, false);
        } catch (error) {
          scheduler.#appendLog(`Task failed: ${errorMessage(error)}.`, false);
        }
        scheduler.#emitInvalidated('executed');
      } catch (error) {
        logger.error(`callback failed for task ${task.id}:`, errorMessage(error));
        scheduler.#appendLog(`Task scheduler failure: ${errorMessage(error)}.`);
      }
    });
    this.#jobs.set(task.id, job);
  }

  async #reconcileMissed(now: Date, includeCurrentMinute: boolean): Promise<void> {
    const result = await this.deps.store.reconcileMissed(now, {
      includeCurrentMinute,
    });
    if (!result.changed) return;
    for (const event of result.events) this.deps.runLog.append(event.message, now);
    this.#rebuildJobs();
    this.#emitInvalidated('missed');
  }

  #rebuildJobs(): void {
    for (const job of this.#jobs.values()) job.stop();
    this.#jobs.clear();
    for (const task of this.deps.store.list()) this.#register(task);
  }

  #snapshot(): ScheduledTasksSnapshot {
    return {
      revision: this.deps.store.revision,
      tasks: this.deps.store.list(),
      runLog: this.deps.runLog.list(),
    };
  }

  #appendLog(message: string, invalidate = true): void {
    this.deps.runLog.append(message);
    if (invalidate) this.#emitInvalidated('log-appended');
  }

  #emitInvalidated(reason: ScheduledTasksInvalidationReason): void {
    this.emit('invalidated', reason);
  }

  get #cron(): CronRuntime {
    return this.deps.cron ?? bunCronRuntime;
  }
}
