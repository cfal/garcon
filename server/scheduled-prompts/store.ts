import path from 'path';
import { JsonFileStore } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import {
  SCHEDULED_PROMPT_MAX_COUNT,
  normalizeScheduledPrompt,
  type ScheduledPrompt,
} from '../../common/scheduled-prompts.js';

interface ScheduledPromptsFile {
  version: 1;
  revision: number;
  prompts: ScheduledPrompt[];
}

export interface OccurrenceClaim {
  scheduledPrompt: ScheduledPrompt;
  nextScheduledPrompt: ScheduledPrompt | null;
}

export interface ReconciliationEvent {
  scheduledPromptId: string;
  message: string;
}

export interface ReconciliationResult {
  changed: boolean;
  events: ReconciliationEvent[];
}

export class ScheduledPromptDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ScheduledPromptDomainError';
  }
}

function emptyFile(): ScheduledPromptsFile {
  return { version: 1, revision: 0, prompts: [] };
}

function normalizeFile(value: unknown): ScheduledPromptsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyFile();
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error(`Unsupported scheduled-prompts.json version: ${String(raw.version)}`);
  }
  const revision =
    typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  const prompts: ScheduledPrompt[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.prompts)) {
    for (const value of raw.prompts) {
      const scheduledPrompt = normalizeScheduledPrompt(value);
      if (!scheduledPrompt || seen.has(scheduledPrompt.id)) continue;
      seen.add(scheduledPrompt.id);
      prompts.push(scheduledPrompt);
    }
  }
  return { version: 1, revision, prompts };
}

function clonePrompt(scheduledPrompt: ScheduledPrompt): ScheduledPrompt {
  return structuredClone(scheduledPrompt);
}

function nextRecurringRun(scheduledPrompt: ScheduledPrompt): string | null {
  if (scheduledPrompt.schedule.type !== 'recurring') return null;
  const next = new Date(
    Date.parse(scheduledPrompt.schedule.nextRunAt) + scheduledPrompt.schedule.intervalDays * 86_400_000,
  ).toISOString();
  return scheduledPrompt.schedule.endAt && next > scheduledPrompt.schedule.endAt ? null : next;
}

export class ScheduledPromptStore {
  readonly #persistence: JsonFileStore<ScheduledPromptsFile>;
  readonly #lock = new KeyedPromiseLock();
  #file: ScheduledPromptsFile = emptyFile();

  constructor(workspaceDir: string) {
    this.#persistence = new JsonFileStore({
      filePath: path.join(workspaceDir, 'scheduled-prompts.json'),
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

  list(): ScheduledPrompt[] {
    return this.#file.prompts.map(clonePrompt);
  }

  get(id: string): ScheduledPrompt | null {
    const scheduledPrompt = this.#file.prompts.find((entry) => entry.id === id);
    return scheduledPrompt ? clonePrompt(scheduledPrompt) : null;
  }

  async create(scheduledPrompt: ScheduledPrompt, expectedRevision: number): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      if (draft.prompts.length >= SCHEDULED_PROMPT_MAX_COUNT) {
        throw new ScheduledPromptDomainError(
          'SCHEDULED_PROMPT_LIMIT_REACHED',
          `A maximum of ${SCHEDULED_PROMPT_MAX_COUNT} scheduled prompts is allowed`,
          409,
        );
      }
      if (draft.prompts.some((entry) => entry.id === scheduledPrompt.id)) {
        throw new ScheduledPromptDomainError('SCHEDULED_PROMPT_ALREADY_EXISTS', 'Scheduled prompt already exists', 409);
      }
      draft.prompts.push(clonePrompt(scheduledPrompt));
      return true;
    });
  }

  async replace(scheduledPrompt: ScheduledPrompt, expectedRevision: number): Promise<ScheduledPrompt> {
    return this.#mutate(expectedRevision, (draft) => {
      const index = draft.prompts.findIndex((entry) => entry.id === scheduledPrompt.id);
      if (index < 0) throw this.#notFound();
      const replacement = {
        ...clonePrompt(scheduledPrompt),
        createdAt: draft.prompts[index].createdAt,
      };
      draft.prompts[index] = replacement;
      return replacement;
    });
  }

  async remove(id: string, expectedRevision: number): Promise<ScheduledPrompt> {
    return this.#mutate(expectedRevision, (draft) => {
      const index = draft.prompts.findIndex((entry) => entry.id === id);
      if (index < 0) throw this.#notFound();
      return draft.prompts.splice(index, 1)[0];
    });
  }

  async restore(scheduledPrompt: ScheduledPrompt): Promise<void> {
    await this.#mutateInternal((draft) => {
      const existing = draft.prompts.findIndex((entry) => entry.id === scheduledPrompt.id);
      if (existing >= 0) draft.prompts[existing] = clonePrompt(scheduledPrompt);
      else draft.prompts.push(clonePrompt(scheduledPrompt));
      return true;
    }, false);
  }

  async reorder(orderedPromptIds: string[], expectedRevision: number): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      const currentIds = draft.prompts.map((scheduledPrompt) => scheduledPrompt.id);
      const supplied = new Set(orderedPromptIds);
      if (
        orderedPromptIds.length !== currentIds.length ||
        supplied.size !== orderedPromptIds.length ||
        currentIds.some((id) => !supplied.has(id))
      ) {
        throw new ScheduledPromptDomainError(
          'SCHEDULED_PROMPT_VALIDATION_FAILED',
          'orderedPromptIds must contain every current prompt exactly once',
          400,
        );
      }
      const byId = new Map(draft.prompts.map((scheduledPrompt) => [scheduledPrompt.id, scheduledPrompt]));
      draft.prompts = orderedPromptIds.map((id) => byId.get(id)!);
      return true;
    });
  }

  async claimOccurrence(id: string, expectedRunAt: string): Promise<OccurrenceClaim | null> {
    return this.#mutateInternal<OccurrenceClaim | null>((draft) => {
      const index = draft.prompts.findIndex((entry) => entry.id === id);
      const scheduledPrompt = draft.prompts[index];
      if (!scheduledPrompt || scheduledPrompt.schedule.nextRunAt !== expectedRunAt) return false;
      const claimed = clonePrompt(scheduledPrompt);
      if (scheduledPrompt.schedule.type === 'once') {
        draft.prompts.splice(index, 1);
        return { scheduledPrompt: claimed, nextScheduledPrompt: null };
      }
      const nextRunAt = nextRecurringRun(scheduledPrompt);
      if (!nextRunAt) {
        draft.prompts.splice(index, 1);
        return { scheduledPrompt: claimed, nextScheduledPrompt: null };
      }
      scheduledPrompt.schedule.nextRunAt = nextRunAt;
      scheduledPrompt.updatedAt = new Date().toISOString();
      return {
        scheduledPrompt: claimed,
        nextScheduledPrompt: clonePrompt(scheduledPrompt),
      };
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
        const nextScheduledPrompts: ScheduledPrompt[] = [];
        for (const scheduledPrompt of draft.prompts) {
          if (!missed(scheduledPrompt.schedule.nextRunAt)) {
            nextScheduledPrompts.push(scheduledPrompt);
            continue;
          }
          if (scheduledPrompt.schedule.type === 'once') {
            events.push({
              scheduledPromptId: scheduledPrompt.id,
              message: `Removed missed one-off prompt scheduled for ${scheduledPrompt.schedule.nextRunAt}.`,
            });
            continue;
          }
          let missedCount = 0;
          let nextRunAt = scheduledPrompt.schedule.nextRunAt;
          while (missed(nextRunAt)) {
            nextRunAt = new Date(
              Date.parse(nextRunAt) + scheduledPrompt.schedule.intervalDays * 86_400_000,
            ).toISOString();
            missedCount += 1;
          }
          if (scheduledPrompt.schedule.endAt && nextRunAt > scheduledPrompt.schedule.endAt) {
            events.push({
              scheduledPromptId: scheduledPrompt.id,
              message: `Removed recurring prompt after skipping ${missedCount} missed occurrence${missedCount === 1 ? '' : 's'}.`,
            });
            continue;
          }
          scheduledPrompt.schedule.nextRunAt = nextRunAt;
          scheduledPrompt.updatedAt = now.toISOString();
          nextScheduledPrompts.push(scheduledPrompt);
          events.push({
            scheduledPromptId: scheduledPrompt.id,
            message: `Skipped ${missedCount} missed occurrence${missedCount === 1 ? '' : 's'}; next run is ${nextRunAt}.`,
          });
        }
        if (events.length === 0) return false;
        draft.prompts = nextScheduledPrompts;
        return { changed: true, events };
      },
      { changed: false, events: [] },
    );
  }

  async #mutate<T>(expectedRevision: number, change: (draft: ScheduledPromptsFile) => T): Promise<T> {
    return this.#lock.runExclusive('scheduled-prompts', async () => {
      if (expectedRevision !== this.#file.revision) {
        throw new ScheduledPromptDomainError(
          'SCHEDULED_PROMPT_REVISION_CONFLICT',
          'Scheduled prompts changed; refresh and try again',
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

  async #mutateInternal<T>(change: (draft: ScheduledPromptsFile) => T | false, unchanged: T): Promise<T> {
    return this.#lock.runExclusive('scheduled-prompts', async () => {
      const draft = structuredClone(this.#file);
      const result = change(draft);
      if (result === false) return structuredClone(unchanged);
      draft.revision += 1;
      await this.#persistence.write(draft);
      this.#file = draft;
      return structuredClone(result);
    });
  }

  #notFound(): ScheduledPromptDomainError {
    return new ScheduledPromptDomainError('SCHEDULED_PROMPT_NOT_FOUND', 'Scheduled prompt not found', 404);
  }
}
