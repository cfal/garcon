import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import {
  SCHEDULED_PROMPT_MAX_COUNT,
  normalizeScheduledPrompt,
  type ScheduledPrompt,
} from '../../common/scheduled-prompts.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import { syncDirectory, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('scheduled-prompts');
const SCHEDULED_PROMPTS_FILE_VERSION = 2;
const HOURS_PER_DAY = 24;

interface ScheduledPromptsFile {
  version: typeof SCHEDULED_PROMPTS_FILE_VERSION;
  revision: number;
  prompts: ScheduledPrompt[];
}

interface NormalizedScheduledPromptsFile {
  file: ScheduledPromptsFile;
  migrated: boolean;
  ignoredPromptCount: number;
  invalidContainerShape: boolean;
}

interface LoadedScheduledPromptsFile extends NormalizedScheduledPromptsFile {
  sourceBytes: Buffer | null;
}

const HOUR_MS = 3_600_000;

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
  return { version: SCHEDULED_PROMPTS_FILE_VERSION, revision: 0, prompts: [] };
}

function normalizeRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeVersionOneScheduledPrompt(value: unknown): ScheduledPrompt | null {
  const scheduledPrompt = normalizeScheduledPrompt(value);
  if (scheduledPrompt) return scheduledPrompt;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const schedule = raw.schedule;
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return null;
  const legacySchedule = schedule as Record<string, unknown>;
  if (legacySchedule.type !== 'recurring') return null;
  const intervalDays = legacySchedule.intervalDays;
  if (typeof intervalDays !== 'number' || !Number.isSafeInteger(intervalDays)) return null;
  return normalizeScheduledPrompt({
    ...raw,
    schedule: {
      ...legacySchedule,
      intervalHours: intervalDays * HOURS_PER_DAY,
    },
  });
}

function normalizeFile(value: unknown): NormalizedScheduledPromptsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { file: emptyFile(), migrated: false, ignoredPromptCount: 0, invalidContainerShape: true };
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 && raw.version !== SCHEDULED_PROMPTS_FILE_VERSION) {
    throw new Error(`Unsupported scheduled-prompts.json version: ${String(raw.version)}`);
  }
  const normalizedRevision = normalizeRevision(raw.revision);
  const revision = normalizedRevision ?? 0;
  const prompts: ScheduledPrompt[] = [];
  const seen = new Set<string>();
  let ignoredPromptCount = 0;
  if (Array.isArray(raw.prompts)) {
    for (const value of raw.prompts) {
      const scheduledPrompt =
        raw.version === 1 ? normalizeVersionOneScheduledPrompt(value) : normalizeScheduledPrompt(value);
      if (!scheduledPrompt || seen.has(scheduledPrompt.id)) {
        ignoredPromptCount += 1;
        continue;
      }
      seen.add(scheduledPrompt.id);
      prompts.push(scheduledPrompt);
    }
  }
  return {
    file: { version: SCHEDULED_PROMPTS_FILE_VERSION, revision, prompts },
    migrated: raw.version === 1,
    ignoredPromptCount,
    invalidContainerShape:
      (raw.revision !== undefined && normalizedRevision === null) ||
      (raw.prompts !== undefined && !Array.isArray(raw.prompts)),
  };
}

async function readFile(filePath: string): Promise<LoadedScheduledPromptsFile> {
  try {
    const sourceBytes = await fs.readFile(filePath);
    return { ...normalizeFile(JSON.parse(sourceBytes.toString('utf8'))), sourceBytes };
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return {
        file: emptyFile(),
        migrated: false,
        ignoredPromptCount: 0,
        invalidContainerShape: false,
        sourceBytes: null,
      };
    }
    throw error;
  }
}

async function findExistingScheduledPromptsBackup(
  filePath: string,
  sourceBytes: Buffer,
  sourceVersion: number,
): Promise<string | null> {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.v${sourceVersion}-backup-`;
  const candidateNames = (await fs.readdir(directory))
    .filter((entry) => entry.startsWith(prefix))
    .sort()
    .reverse();

  for (const candidateName of candidateNames) {
    const candidatePath = path.join(directory, candidateName);
    try {
      const candidateStat = await fs.lstat(candidatePath);
      if (
        !candidateStat.isFile() ||
        (candidateStat.mode & 0o077) !== 0 ||
        candidateStat.size !== sourceBytes.length
      ) {
        continue;
      }
      const candidateBytes = await fs.readFile(candidatePath);
      if (candidateBytes.equals(sourceBytes)) return candidatePath;
    } catch {
      continue;
    }
  }
  return null;
}

async function backupScheduledPromptsFile(
  filePath: string,
  sourceBytes: Buffer,
  sourceVersion: number,
): Promise<string> {
  const existingBackupPath = await findExistingScheduledPromptsBackup(filePath, sourceBytes, sourceVersion);
  if (existingBackupPath) return existingBackupPath;

  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  const backupPath = `${filePath}.v${sourceVersion}-backup-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
  let backupFile: Awaited<ReturnType<typeof fs.open>> | null = null;
  let backupCreated = false;
  try {
    backupFile = await fs.open(backupPath, 'wx', 0o600);
    backupCreated = true;
    await backupFile.writeFile(sourceBytes);
    await backupFile.sync();
    await backupFile.close();
    backupFile = null;
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (backupFile) await backupFile.close().catch(() => {});
    if (backupCreated) await fs.unlink(backupPath).catch(() => {});
    throw error;
  }
  return backupPath;
}

function clonePrompt(scheduledPrompt: ScheduledPrompt): ScheduledPrompt {
  return structuredClone(scheduledPrompt);
}

function nextRecurringRun(scheduledPrompt: ScheduledPrompt): string | null {
  if (scheduledPrompt.schedule.type !== 'recurring') return null;
  const next = new Date(
    Date.parse(scheduledPrompt.schedule.nextRunAt) + scheduledPrompt.schedule.intervalHours * HOUR_MS,
  ).toISOString();
  return scheduledPrompt.schedule.endAt && next > scheduledPrompt.schedule.endAt ? null : next;
}

export class ScheduledPromptStore {
  readonly #filePath: string;
  readonly #lock = new KeyedPromiseLock();
  #file: ScheduledPromptsFile = emptyFile();

  constructor(workspaceDir: string) {
    this.#filePath = path.join(workspaceDir, 'scheduled-prompts.json');
  }

  async init(): Promise<void> {
    const loaded = await readFile(this.#filePath);
    let backupPath: string | null = null;
    if (loaded.migrated || loaded.ignoredPromptCount > 0 || loaded.invalidContainerShape) {
      if (!loaded.sourceBytes) throw new Error('scheduled-prompts.json source is unavailable for backup');
      const sourceVersion = loaded.migrated ? 1 : SCHEDULED_PROMPTS_FILE_VERSION;
      backupPath = await backupScheduledPromptsFile(this.#filePath, loaded.sourceBytes, sourceVersion);
    }
    const backupMessage = backupPath ? ` Original file backed up to ${backupPath}.` : '';
    if (loaded.invalidContainerShape) {
      logger.warn(`Found invalid scheduled-prompts.json container data while loading.${backupMessage}`);
    }
    if (loaded.ignoredPromptCount > 0) {
      logger.warn(
        `Ignored ${loaded.ignoredPromptCount} invalid or duplicate scheduled prompt record${loaded.ignoredPromptCount === 1 ? '' : 's'} while loading scheduled-prompts.json.${backupMessage}`,
      );
    }
    if (loaded.migrated) {
      await this.#write(loaded.file);
      logger.info(
        `Migrated scheduled-prompts.json from version 1 to version 2. Original file backed up to ${backupPath}.`,
      );
    }
    this.#file = loaded.file;
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
          const nextRunMs = Date.parse(scheduledPrompt.schedule.nextRunAt);
          const intervalMs = scheduledPrompt.schedule.intervalHours * HOUR_MS;
          const elapsedMs = minute - nextRunMs;
          const missedCount = options.includeCurrentMinute
            ? Math.floor(elapsedMs / intervalMs) + 1
            : Math.ceil(elapsedMs / intervalMs);
          const nextRunAt = new Date(nextRunMs + missedCount * intervalMs).toISOString();
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
      await this.#write(draft);
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
      await this.#write(draft);
      this.#file = draft;
      return structuredClone(result);
    });
  }

  async #write(file: ScheduledPromptsFile): Promise<void> {
    await writeJsonFileAtomic(this.#filePath, file, { mode: 0o600 });
  }

  #notFound(): ScheduledPromptDomainError {
    return new ScheduledPromptDomainError('SCHEDULED_PROMPT_NOT_FOUND', 'Scheduled prompt not found', 404);
  }
}
