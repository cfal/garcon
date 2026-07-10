import path from 'path';
import { JsonFileStore } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { SCHEDULED_TASK_MAX_COUNT, normalizeScheduledTask, type ScheduledTask } from '../../common/scheduled-tasks.js';

interface ScheduledTasksFile {
  version: 1;
  revision: number;
  tasks: ScheduledTask[];
}

export interface OccurrenceClaim {
  task: ScheduledTask;
  nextTask: ScheduledTask | null;
}

export interface ReconciliationEvent {
  taskId: string;
  message: string;
}

export interface ReconciliationResult {
  changed: boolean;
  events: ReconciliationEvent[];
}

export class ScheduledTaskDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ScheduledTaskDomainError';
  }
}

function emptyFile(): ScheduledTasksFile {
  return { version: 1, revision: 0, tasks: [] };
}

function normalizeFile(value: unknown): ScheduledTasksFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyFile();
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error(`Unsupported scheduled-tasks.json version: ${String(raw.version)}`);
  }
  const revision =
    typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  const tasks: ScheduledTask[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.tasks)) {
    for (const value of raw.tasks) {
      const task = normalizeScheduledTask(value);
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);
      tasks.push(task);
    }
  }
  return { version: 1, revision, tasks };
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return structuredClone(task);
}

function nextRecurringRun(task: ScheduledTask): string | null {
  if (task.schedule.type !== 'recurring') return null;
  const next = new Date(Date.parse(task.schedule.nextRunAt) + task.schedule.intervalDays * 86_400_000).toISOString();
  return task.schedule.endAt && next > task.schedule.endAt ? null : next;
}

export class ScheduledTaskStore {
  readonly #persistence: JsonFileStore<ScheduledTasksFile>;
  readonly #lock = new KeyedPromiseLock();
  #file: ScheduledTasksFile = emptyFile();

  constructor(workspaceDir: string) {
    this.#persistence = new JsonFileStore({
      filePath: path.join(workspaceDir, 'scheduled-tasks.json'),
      mode: 0o600,
      empty: emptyFile,
      normalize: normalizeFile,
    });
  }

  async init(): Promise<void> {
    this.#file = await this.#persistence.read();
  }

  get revision(): number {
    return this.#file.revision;
  }

  list(): ScheduledTask[] {
    return this.#file.tasks.map(cloneTask);
  }

  get(id: string): ScheduledTask | null {
    const task = this.#file.tasks.find((entry) => entry.id === id);
    return task ? cloneTask(task) : null;
  }

  async create(task: ScheduledTask, expectedRevision: number): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      if (draft.tasks.length >= SCHEDULED_TASK_MAX_COUNT) {
        throw new ScheduledTaskDomainError(
          'SCHEDULED_TASK_LIMIT_REACHED',
          `A maximum of ${SCHEDULED_TASK_MAX_COUNT} scheduled tasks is allowed`,
          409,
        );
      }
      if (draft.tasks.some((entry) => entry.id === task.id)) {
        throw new ScheduledTaskDomainError('SCHEDULED_TASK_ALREADY_EXISTS', 'Scheduled task already exists', 409);
      }
      draft.tasks.push(cloneTask(task));
      return true;
    });
  }

  async replace(task: ScheduledTask, expectedRevision: number): Promise<ScheduledTask> {
    return this.#mutate(expectedRevision, (draft) => {
      const index = draft.tasks.findIndex((entry) => entry.id === task.id);
      if (index < 0) throw this.#notFound();
      const replacement = {
        ...cloneTask(task),
        createdAt: draft.tasks[index].createdAt,
      };
      draft.tasks[index] = replacement;
      return replacement;
    });
  }

  async remove(id: string, expectedRevision: number): Promise<ScheduledTask> {
    return this.#mutate(expectedRevision, (draft) => {
      const index = draft.tasks.findIndex((entry) => entry.id === id);
      if (index < 0) throw this.#notFound();
      return draft.tasks.splice(index, 1)[0];
    });
  }

  async restore(task: ScheduledTask): Promise<void> {
    await this.#mutateInternal((draft) => {
      const existing = draft.tasks.findIndex((entry) => entry.id === task.id);
      if (existing >= 0) draft.tasks[existing] = cloneTask(task);
      else draft.tasks.push(cloneTask(task));
      return true;
    }, false);
  }

  async reorder(orderedTaskIds: string[], expectedRevision: number): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      const currentIds = draft.tasks.map((task) => task.id);
      const supplied = new Set(orderedTaskIds);
      if (
        orderedTaskIds.length !== currentIds.length ||
        supplied.size !== orderedTaskIds.length ||
        currentIds.some((id) => !supplied.has(id))
      ) {
        throw new ScheduledTaskDomainError(
          'SCHEDULED_TASK_VALIDATION_FAILED',
          'orderedTaskIds must contain every current task exactly once',
          400,
        );
      }
      const byId = new Map(draft.tasks.map((task) => [task.id, task]));
      draft.tasks = orderedTaskIds.map((id) => byId.get(id)!);
      return true;
    });
  }

  async claimOccurrence(id: string, expectedRunAt: string): Promise<OccurrenceClaim | null> {
    return this.#mutateInternal<OccurrenceClaim | null>((draft) => {
      const index = draft.tasks.findIndex((entry) => entry.id === id);
      const task = draft.tasks[index];
      if (!task || task.schedule.nextRunAt !== expectedRunAt) return false;
      const claimed = cloneTask(task);
      if (task.schedule.type === 'once') {
        draft.tasks.splice(index, 1);
        return { task: claimed, nextTask: null };
      }
      const nextRunAt = nextRecurringRun(task);
      if (!nextRunAt) {
        draft.tasks.splice(index, 1);
        return { task: claimed, nextTask: null };
      }
      task.schedule.nextRunAt = nextRunAt;
      task.updatedAt = new Date().toISOString();
      return { task: claimed, nextTask: cloneTask(task) };
    }, null);
  }

  async reconcileMissed(now: Date, options: { includeCurrentMinute?: boolean } = {}): Promise<ReconciliationResult> {
    const minute = Math.floor(now.getTime() / 60_000) * 60_000;
    const missed = (instant: string) => {
      const value = Date.parse(instant);
      return options.includeCurrentMinute ? value <= minute : value < minute;
    };
    return this.#mutateInternal<ReconciliationResult>(
      (draft) => {
        const events: ReconciliationEvent[] = [];
        const nextTasks: ScheduledTask[] = [];
        for (const task of draft.tasks) {
          if (!missed(task.schedule.nextRunAt)) {
            nextTasks.push(task);
            continue;
          }
          if (task.schedule.type === 'once') {
            events.push({
              taskId: task.id,
              message: `Removed missed one-off task scheduled for ${task.schedule.nextRunAt}.`,
            });
            continue;
          }
          let missedCount = 0;
          let nextRunAt = task.schedule.nextRunAt;
          while (missed(nextRunAt)) {
            nextRunAt = new Date(Date.parse(nextRunAt) + task.schedule.intervalDays * 86_400_000).toISOString();
            missedCount += 1;
          }
          if (task.schedule.endAt && nextRunAt > task.schedule.endAt) {
            events.push({
              taskId: task.id,
              message: `Removed recurring task after skipping ${missedCount} missed occurrence${missedCount === 1 ? '' : 's'}.`,
            });
            continue;
          }
          task.schedule.nextRunAt = nextRunAt;
          task.updatedAt = now.toISOString();
          nextTasks.push(task);
          events.push({
            taskId: task.id,
            message: `Skipped ${missedCount} missed occurrence${missedCount === 1 ? '' : 's'}; next run is ${nextRunAt}.`,
          });
        }
        if (events.length === 0) return false;
        draft.tasks = nextTasks;
        return { changed: true, events };
      },
      { changed: false, events: [] },
    );
  }

  async #mutate<T>(expectedRevision: number, change: (draft: ScheduledTasksFile) => T): Promise<T> {
    return this.#lock.runExclusive('scheduled-tasks', async () => {
      if (expectedRevision !== this.#file.revision) {
        throw new ScheduledTaskDomainError(
          'SCHEDULED_TASK_REVISION_CONFLICT',
          'Scheduled tasks changed; refresh and try again',
          409,
          true,
        );
      }
      const draft = structuredClone(this.#file);
      const result = change(draft);
      draft.revision += 1;
      await this.#persistence.write(draft);
      this.#file = draft;
      return structuredClone(result);
    });
  }

  async #mutateInternal<T>(change: (draft: ScheduledTasksFile) => T | false, unchanged: T): Promise<T> {
    return this.#lock.runExclusive('scheduled-tasks', async () => {
      const draft = structuredClone(this.#file);
      const result = change(draft);
      if (result === false) return structuredClone(unchanged);
      draft.revision += 1;
      await this.#persistence.write(draft);
      this.#file = draft;
      return structuredClone(result);
    });
  }

  #notFound(): ScheduledTaskDomainError {
    return new ScheduledTaskDomainError('SCHEDULED_TASK_NOT_FOUND', 'Scheduled task not found', 404);
  }
}
