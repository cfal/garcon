import crypto from 'crypto';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import {
  normalizeScheduledPromptDefinitionInput,
  type CreateScheduledPromptRequest,
  type ReorderScheduledPromptsRequest,
  type RemoveScheduledPromptRequest,
  type ScheduleInPromptRequest,
  type ScheduledPrompt,
  type ScheduledPromptDefinitionInput,
  type ScheduledPromptsInvalidationReason,
  type ScheduledPromptsSnapshot,
  type UpdateScheduledPromptRequest,
} from '../../common/scheduled-prompts.js';
import { parseScheduleDuration, scheduleInRunAt, type ScheduleDurationError } from '../../common/schedule-duration.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { IChatRegistry } from '../chats/store.js';
import { errorMessage } from '../lib/errors.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import { createLogger } from '../lib/log.js';
import type { ScheduledPromptDispatcher } from './dispatcher.js';
import { ScheduledPromptRunLog } from './run-log.js';
import { ScheduledPromptDomainError, ScheduledPromptStore } from './store.js';

const logger = createLogger('scheduled-prompts');
const SCHEDULER_LOCK = 'scheduled-prompts-scheduler';

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

function scheduleDurationDomainError(error: ScheduleDurationError): ScheduledPromptDomainError {
  const definitions: Record<ScheduleDurationError, { code: string; message: string }> = {
    missing: {
      code: 'SCHEDULE_IN_DURATION_REQUIRED',
      message: 'Duration is required',
    },
    'sub-minute-unsupported': {
      code: 'SCHEDULE_IN_SUB_MINUTE_UNSUPPORTED',
      message: 'Seconds and milliseconds are not supported; use at least one minute',
    },
    'invalid-format': {
      code: 'SCHEDULE_IN_DURATION_INVALID',
      message: 'Duration format is invalid',
    },
    'too-short': {
      code: 'SCHEDULE_IN_DURATION_TOO_SHORT',
      message: 'Duration must be at least one minute',
    },
    'too-long': {
      code: 'SCHEDULE_IN_DURATION_TOO_LONG',
      message: 'Duration cannot exceed 365 days',
    },
  };
  const definition = definitions[error];
  return new ScheduledPromptDomainError(definition.code, definition.message, 400);
}

export interface ScheduleInResult {
  scheduledPrompt: ScheduledPrompt;
  snapshot: ScheduledPromptsSnapshot;
}

interface ScheduledPromptSchedulerEvents {
  invalidated: [reason: ScheduledPromptsInvalidationReason];
}

export class ScheduledPromptScheduler extends EventEmitter<ScheduledPromptSchedulerEvents> {
  readonly #jobs = new Map<string, Bun.CronJob>();
  readonly #lock = new KeyedPromiseLock();
  #reconciliationJob: Bun.CronJob | null = null;
  #stopped = false;

  constructor(
    private readonly deps: {
      store: ScheduledPromptStore;
      runLog: ScheduledPromptRunLog;
      dispatcher: ScheduledPromptDispatcher;
      chats: Pick<IChatRegistry, 'getChat'>;
      agents: Pick<AgentRegistryServiceContract, 'hasAgent'>;
      cron?: CronRuntime;
    },
  ) {
    super();
  }

  onInvalidated(callback: (reason: ScheduledPromptsInvalidationReason) => void): void {
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
          scheduler.#appendLog(`Prompt reconciliation failed: ${errorMessage(error)}.`);
        }
      });
    });
    logger.info(`registered ${this.#jobs.size} scheduled prompt(s)`);
  }

  stop(): void {
    this.#stopped = true;
    this.#reconciliationJob?.stop();
    this.#reconciliationJob = null;
    for (const job of this.#jobs.values()) job.stop();
    this.#jobs.clear();
  }

  async snapshotAfterReconciliation(): Promise<ScheduledPromptsSnapshot> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      await this.#reconcileMissed(new Date(), false);
      return this.#snapshot();
    });
  }

  async create(request: CreateScheduledPromptRequest): Promise<ScheduledPromptsSnapshot> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      const now = new Date();
      await this.#reconcileMissed(now, false);
      const definition = await this.#validateDefinition(request.scheduledPrompt, now);
      await this.#createDefinition(definition, now, request.expectedRevision);
      return this.#snapshot();
    });
  }

  async scheduleIn(request: ScheduleInPromptRequest, fixedNow?: Date): Promise<ScheduleInResult> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      await this.#reconcileMissed(fixedNow ?? new Date(), false);
      const now = fixedNow ?? new Date();
      const chatId = typeof request?.chatId === 'string' ? request.chatId.trim() : '';
      const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
      const durationToken = typeof request?.duration === 'string' ? request.duration : '';
      const duration = parseScheduleDuration(durationToken);
      if (!duration.ok) throw scheduleDurationDomainError(duration.error);

      const definition = await this.#validateDefinition(
        {
          schedule: {
            type: 'once',
            runAtUtc: scheduleInRunAt(now, duration.minutes),
          },
          target: { type: 'existing-chat', chatId, busyBehavior: 'skip' },
          prompt,
        },
        now,
      );
      const scheduledPrompt = await this.#createDefinition(definition, now, this.deps.store.revision);
      return {
        scheduledPrompt: structuredClone(scheduledPrompt),
        snapshot: this.#snapshot(),
      };
    });
  }

  async update(request: UpdateScheduledPromptRequest): Promise<ScheduledPromptsSnapshot> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      await this.#reconcileMissed(new Date(), false);
      const previous = this.deps.store.get(request.id);
      if (!previous) {
        throw new ScheduledPromptDomainError('SCHEDULED_PROMPT_NOT_FOUND', 'Scheduled prompt not found', 404);
      }
      const definition = await this.#validateDefinition(request.scheduledPrompt);
      const replacement = this.#promptFromDefinition(request.id, definition, new Date(), previous.createdAt);
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

  async remove(request: RemoveScheduledPromptRequest): Promise<ScheduledPromptsSnapshot> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      await this.#reconcileMissed(new Date(), false);
      await this.deps.store.remove(request.id.trim(), request.expectedRevision);
      this.#jobs.get(request.id)?.stop();
      this.#jobs.delete(request.id);
      this.#emitInvalidated('removed');
      return this.#snapshot();
    });
  }

  async reorder(request: ReorderScheduledPromptsRequest): Promise<ScheduledPromptsSnapshot> {
    return this.#lock.runExclusive(SCHEDULER_LOCK, async () => {
      await this.#reconcileMissed(new Date(), false);
      await this.deps.store.reorder(request.orderedPromptIds, request.expectedRevision);
      this.#emitInvalidated('reordered');
      return this.#snapshot();
    });
  }

  async #validateDefinition(value: unknown, now = new Date()): Promise<ScheduledPromptDefinitionInput> {
    const definition = normalizeScheduledPromptDefinitionInput(value);
    if (!definition) {
      throw new ScheduledPromptDomainError('SCHEDULED_PROMPT_VALIDATION_FAILED', 'Scheduled prompt is invalid', 400);
    }
    const firstRunAt =
      definition.schedule.type === 'once' ? definition.schedule.runAtUtc : definition.schedule.firstRunAtUtc;
    if (Date.parse(firstRunAt) < nextMinute(now)) {
      throw new ScheduledPromptDomainError(
        'SCHEDULED_PROMPT_VALIDATION_FAILED',
        'The first run must be at least the next minute',
        400,
      );
    }
    if (definition.target.type === 'existing-chat') {
      if (!this.deps.chats.getChat(definition.target.chatId)) {
        throw new ScheduledPromptDomainError('SESSION_NOT_FOUND', 'Selected chat was not found', 404);
      }
      return definition;
    }
    if (!this.deps.agents.hasAgent(definition.target.agentId)) {
      throw new ScheduledPromptDomainError('UNSUPPORTED_AGENT', `Unsupported agent: ${definition.target.agentId}`, 422);
    }
    try {
      const resolved = await assertRealWithinProjectBase(definition.target.projectPath);
      if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Project path is not a directory');
    } catch (error) {
      if (isProjectBoundaryError(error)) {
        throw new ScheduledPromptDomainError(
          'PROJECT_PATH_OUTSIDE_BASE',
          'Project path is outside the allowed base directory',
          403,
        );
      }
      throw new ScheduledPromptDomainError('PROJECT_PATH_NOT_FOUND', 'Project path was not found', 404);
    }
    return definition;
  }

  async #createDefinition(
    definition: ScheduledPromptDefinitionInput,
    now: Date,
    expectedRevision: number,
  ): Promise<ScheduledPrompt> {
    const scheduledPrompt = this.#promptFromDefinition(crypto.randomUUID(), definition, now);
    await this.deps.store.create(scheduledPrompt, expectedRevision);
    try {
      this.#register(scheduledPrompt);
    } catch (error) {
      await this.deps.store.remove(scheduledPrompt.id, this.deps.store.revision).catch(() => {});
      throw error;
    }
    this.#emitInvalidated('created');
    return scheduledPrompt;
  }

  #promptFromDefinition(
    id: string,
    definition: ScheduledPromptDefinitionInput,
    now: Date,
    createdAt = now.toISOString(),
  ): ScheduledPrompt {
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

  #register(scheduledPrompt: ScheduledPrompt): void {
    if (this.#stopped) return;
    this.#jobs.get(scheduledPrompt.id)?.stop();
    const expectedRunAt = scheduledPrompt.schedule.nextRunAt;
    const expectedMs = Date.parse(expectedRunAt);
    const scheduler = this;
    const job = this.#cron.schedule(cronExpressionForUtcInstant(expectedRunAt), async function () {
      try {
        if (scheduler.#jobs.get(scheduledPrompt.id) !== this) {
          this.stop();
          return;
        }
        const now = Date.now();
        if (now < expectedMs) return;
        this.stop();
        scheduler.#jobs.delete(scheduledPrompt.id);
        if (!sameUtcMinute(now, expectedMs)) {
          await scheduler.#lock.runExclusive(SCHEDULER_LOCK, async () => {
            await scheduler.#reconcileMissed(new Date(now), false);
          });
          return;
        }
        const claim = await scheduler.#lock.runExclusive(SCHEDULER_LOCK, async () => {
          const claimed = await scheduler.deps.store.claimOccurrence(scheduledPrompt.id, expectedRunAt);
          if (claimed?.nextScheduledPrompt) scheduler.#register(claimed.nextScheduledPrompt);
          return claimed;
        });
        if (!claim) return;
        try {
          const outcome = await scheduler.deps.dispatcher.dispatch(claim.scheduledPrompt, expectedRunAt);
          scheduler.#appendLog(outcome.message, false);
        } catch (error) {
          scheduler.#appendLog(`Prompt failed: ${errorMessage(error)}.`, false);
        }
        scheduler.#emitInvalidated('executed');
      } catch (error) {
        logger.error(`callback failed for prompt ${scheduledPrompt.id}:`, errorMessage(error));
        scheduler.#appendLog(`Prompt scheduler failure: ${errorMessage(error)}.`);
      }
    });
    this.#jobs.set(scheduledPrompt.id, job);
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
    for (const scheduledPrompt of this.deps.store.list()) this.#register(scheduledPrompt);
  }

  #snapshot(): ScheduledPromptsSnapshot {
    return {
      revision: this.deps.store.revision,
      prompts: this.deps.store.list(),
      runLog: this.deps.runLog.list(),
    };
  }

  #appendLog(message: string, invalidate = true): void {
    this.deps.runLog.append(message);
    if (invalidate) this.#emitInvalidated('log-appended');
  }

  #emitInvalidated(reason: ScheduledPromptsInvalidationReason): void {
    this.emit('invalidated', reason);
  }

  get #cron(): CronRuntime {
    return this.deps.cron ?? bunCronRuntime;
  }
}
