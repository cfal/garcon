import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  isPreambleId,
  PREAMBLE_ID_LIFETIME_MAX_COUNT,
  PREAMBLE_MAX_COUNT,
  PREAMBLES_FILE_MAX_BYTES,
  normalizePreamble,
  type Preamble,
  type PreambleDefinitionInput,
  type PreamblesSnapshot,
} from '../../common/preambles.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { assertRealWithinProjectBase } from '../lib/path-boundary.js';
import { assertPreambleCatalogComposition, PreambleDomainError } from './errors.js';
import { preambleCatalogCompositionViolation } from './catalog-budget.js';

const PREAMBLES_FILE_VERSION = 2;

interface PreamblesFile {
  readonly version: typeof PREAMBLES_FILE_VERSION;
  revision: number;
  preambles: Preamble[];
  retiredPreambleIds: string[];
}

function emptyFile(): PreamblesFile {
  return {
    version: PREAMBLES_FILE_VERSION,
    revision: 0,
    preambles: [],
    retiredPreambleIds: [],
  };
}

const encoder = new TextEncoder();

// The exact final payload: the serialized draft plus the trailing newline the
// atomic writer appends. The ceiling must cover what is actually written.
function fileByteLength(file: PreamblesFile): number {
  return encoder.encode(`${JSON.stringify(file, null, 2)}\n`).byteLength;
}

function parseActivePreambles(raw: unknown): Preamble[] {
  if (!Array.isArray(raw) || raw.length > PREAMBLE_MAX_COUNT) {
    throw new Error('preambles.json is invalid');
  }
  const ids = new Set<string>();
  return raw.map((valuePreamble) => {
    const preamble = normalizePreamble(valuePreamble);
    if (!preamble || ids.has(preamble.id)) throw new Error('preambles.json contains an invalid preamble');
    const rawRules = preamble.scope.type === 'project-paths'
      ? (valuePreamble as { scope: { rules: { projectPath: string }[] } }).scope.rules
      : [];
    if (
      preamble.scope.type === 'project-paths'
      && preamble.scope.rules.some((rule, index) => (
        rawRules[index]?.projectPath !== rule.projectPath
        || !path.isAbsolute(rule.projectPath)
        || path.resolve(rule.projectPath) !== rule.projectPath
      ))
    ) throw new Error('preambles.json contains a non-canonical project path');
    ids.add(preamble.id);
    return preamble;
  });
}

function parseRetiredIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('preambles.json is invalid');
  const retired = new Set<string>();
  for (const id of raw) {
    if (!isPreambleId(id) || retired.has(id)) {
      throw new Error('preambles.json contains an invalid retired preamble ID');
    }
    retired.add(id);
  }
  return [...retired];
}

// The permanent non-reuse guarantee begins with the version-2 migration; every
// active version-1 ID must already be a canonical UUID v4.
function normalizeVersionOneFile(value: unknown): PreamblesFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('preambles.json must contain an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error(`Unsupported preambles.json version: ${String(raw.version)}`);
  }
  if (
    Object.keys(raw).some((key) => !['version', 'revision', 'preambles'].includes(key))
    || !Number.isSafeInteger(raw.revision)
    || (raw.revision as number) < 0
  ) throw new Error('preambles.json is invalid');
  const preambles = parseActivePreambles(raw.preambles);
  return { version: PREAMBLES_FILE_VERSION, revision: raw.revision as number, preambles, retiredPreambleIds: [] };
}

function normalizeVersionTwoFile(value: unknown): PreamblesFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('preambles.json must contain an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== PREAMBLES_FILE_VERSION) {
    throw new Error(`Unsupported preambles.json version: ${String(raw.version)}`);
  }
  if (
    Object.keys(raw).some((key) =>
      !['version', 'revision', 'preambles', 'retiredPreambleIds'].includes(key))
    || !Number.isSafeInteger(raw.revision)
    || (raw.revision as number) < 0
  ) throw new Error('preambles.json is invalid');
  const preambles = parseActivePreambles(raw.preambles);
  const retiredPreambleIds = parseRetiredIds(raw.retiredPreambleIds);
  if (retiredPreambleIds.some((id) => preambles.some((preamble) => preamble.id === id))) {
    throw new Error('preambles.json contains an ID that is both active and retired');
  }
  if (preambles.length + retiredPreambleIds.length > PREAMBLE_ID_LIFETIME_MAX_COUNT) {
    throw new Error('preambles.json exceeds the preamble ID lifetime limit');
  }
  return { version: PREAMBLES_FILE_VERSION, revision: raw.revision as number, preambles, retiredPreambleIds };
}

// The rename completed, so the candidate is authoritative in the file and has
// been installed in memory; only its durability is unknown. Later mutations are
// fenced until an explicit sync retry succeeds or a restart reloads the file.
export class PreambleCatalogCommittedUnknownError extends Error {
  constructor(cause: unknown) {
    super('The preambles catalog was committed, but its durability could not be confirmed.', {
      cause,
    });
    this.name = 'PreambleCatalogCommittedUnknownError';
  }
}

export class PreambleStore {
  readonly #filePath: string;
  readonly #lock = new KeyedPromiseLock();
  #file = emptyFile();
  #mutationFence: 'clear' | 'unknown-durability' = 'clear';

  constructor(workspaceDir: string) {
    this.#filePath = path.join(workspaceDir, 'preambles.json');
  }

  async init(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
      this.#file = emptyFile();
      this.#mutationFence = 'clear';
      return;
    }
    if (encoder.encode(raw).byteLength > PREAMBLES_FILE_MAX_BYTES) {
      throw new Error('preambles.json exceeds the maximum file size');
    }
    const parsed: unknown = JSON.parse(raw);
    const migrated = (parsed as { version?: unknown })?.version === 1;
    const file = migrated ? normalizeVersionOneFile(parsed) : normalizeVersionTwoFile(parsed);
    await assertCanonicalProjectPaths(file.preambles);
    if (preambleCatalogCompositionViolation(file.preambles)) {
      throw new Error('preambles.json contains an invalid combined preamble composition');
    }
    if (migrated) {
      if (fileByteLength(file) > PREAMBLES_FILE_MAX_BYTES) {
        throw new Error('Migrated preambles.json would exceed the maximum file size');
      }
      await this.#write(file);
    }
    this.#file = file;
    this.#mutationFence = 'clear';
  }

  snapshot(): PreamblesSnapshot {
    return { revision: this.#file.revision, preambles: structuredClone(this.#file.preambles) };
  }

  lifetimeIdCount(): number {
    return this.#file.preambles.length + this.#file.retiredPreambleIds.length;
  }

  // Generates exactly one canonical ID under the mutation lock after the
  // revision check, so a stale request gets the revision conflict and the
  // ceiling can never be raced past with a pre-generated ID.
  async createWithGeneratedId(
    expectedRevision: number,
    generate: () => string,
    build: (id: string) => Preamble,
  ): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      this.#assertCreateBounds(draft);
      const id = generate();
      // A malformed, active, or retired generated ID is rejected, never
      // normalized or retried in a loop; the collision may indicate a broken
      // generator.
      if (!isPreambleId(id)) {
        throw new PreambleDomainError(
          'PREAMBLE_VALIDATION_FAILED',
          'Generated preamble ID is not a canonical UUID v4',
          500,
        );
      }
      this.#assertIdAvailable(draft, id);
      const preamble = normalizeCreatedPreamble(build(id));
      if (preamble.id !== id) {
        throw new PreambleDomainError(
          'PREAMBLE_VALIDATION_FAILED',
          'Generated preamble does not use its assigned ID',
          500,
        );
      }
      draft.preambles.push(preamble);
    });
  }

  #assertCreateBounds(draft: PreamblesFile): void {
    if (draft.preambles.length >= PREAMBLE_MAX_COUNT) {
      throw new PreambleDomainError(
        'PREAMBLE_LIMIT_REACHED',
        `A maximum of ${PREAMBLE_MAX_COUNT} preambles is allowed`,
        409,
      );
    }
    if (draft.preambles.length + draft.retiredPreambleIds.length
      >= PREAMBLE_ID_LIFETIME_MAX_COUNT) {
      throw new PreambleDomainError(
        'PREAMBLE_ID_LIFETIME_LIMIT_REACHED',
        `The workspace preamble ID lifetime limit of ${PREAMBLE_ID_LIFETIME_MAX_COUNT} is reached`,
        409,
      );
    }
  }

  #assertIdAvailable(draft: PreamblesFile, id: string): void {
    const active = draft.preambles.some((entry) => entry.id === id);
    if (!active && !draft.retiredPreambleIds.includes(id)) return;
    throw new PreambleDomainError(
      'PREAMBLE_ID_COLLISION',
      'Generated preamble ID collides with an active or retired ID',
      409,
    );
  }

  async create(preamble: Preamble, expectedRevision: number): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      this.#assertCreateBounds(draft);
      const normalized = normalizeCreatedPreamble(preamble);
      this.#assertIdAvailable(draft, normalized.id);
      draft.preambles.push(normalized);
    });
  }

  async update(
    id: string,
    definition: PreambleDefinitionInput,
    updatedAt: string,
    expectedRevision: number,
  ): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      const index = draft.preambles.findIndex((entry) => entry.id === id);
      if (index < 0) throw this.#notFound();
      const current = draft.preambles[index]!;
      draft.preambles[index] = {
        ...current,
        ...structuredClone(definition),
        updatedAt: nextUpdatedAt(current.updatedAt, updatedAt),
      };
    });
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      const index = draft.preambles.findIndex((entry) => entry.id === id);
      if (index < 0) throw this.#notFound();
      const [removed] = draft.preambles.splice(index, 1);
      draft.retiredPreambleIds.push(removed!.id);
    });
  }

  async reorder(orderedIds: readonly string[], expectedRevision: number): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      const reordered = reorderedPreambles(draft.preambles, orderedIds);
      if (!reordered) {
        throw new PreambleDomainError('PREAMBLE_VALIDATION_FAILED', 'Preamble order is invalid', 400);
      }
      draft.preambles = reordered;
    });
  }

  async #mutate(expectedRevision: number, change: (draft: PreamblesFile) => void): Promise<void> {
    await this.#lock.runExclusive('preambles', async () => {
      if (this.#mutationFence === 'unknown-durability') {
        throw new PreambleDomainError(
          'PREAMBLE_CATALOG_SAVE_UNKNOWN',
          'The preambles catalog has an unconfirmed save; restart the server before further catalog changes.',
          503,
          false,
        );
      }
      if (expectedRevision !== this.#file.revision) {
        throw new PreambleDomainError(
          'PREAMBLE_REVISION_CONFLICT',
          'Preambles changed in another client; refresh and try again',
          409,
          true,
        );
      }
      if (this.#file.revision === Number.MAX_SAFE_INTEGER) {
        throw new PreambleDomainError(
          'PREAMBLE_REVISION_EXHAUSTED',
          'Preamble revision limit reached',
          409,
        );
      }
      const draft = structuredClone(this.#file);
      change(draft);
      if (draft.preambles.length + draft.retiredPreambleIds.length > PREAMBLE_ID_LIFETIME_MAX_COUNT) {
        throw new PreambleDomainError(
          'PREAMBLE_ID_LIFETIME_LIMIT_REACHED',
          `The workspace preamble ID lifetime limit of ${PREAMBLE_ID_LIFETIME_MAX_COUNT} is reached`,
          409,
        );
      }
      assertPreambleCatalogComposition(draft.preambles);
      draft.revision += 1;
      if (fileByteLength(draft) > PREAMBLES_FILE_MAX_BYTES) {
        throw new PreambleDomainError(
          'PREAMBLE_VALIDATION_FAILED',
          'The preambles catalog would exceed the maximum file size',
          400,
        );
      }
      try {
        await this.#write(draft);
      } catch (error) {
        if (error instanceof PreambleCatalogCommittedUnknownError) {
          // The renamed candidate is authoritative and installed; fencing keeps a
          // later mutation from overwriting a committed selection or tombstone.
          this.#file = draft;
          this.#mutationFence = 'unknown-durability';
        }
        throw error;
      }
      this.#file = draft;
    });
  }

  async #write(draft: PreamblesFile): Promise<void> {
    try {
      await writeJsonFileAtomic(this.#filePath, draft, { mode: 0o600 });
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) {
        throw new PreambleCatalogCommittedUnknownError(error);
      }
      throw error;
    }
  }

  #notFound(): PreambleDomainError {
    return new PreambleDomainError('PREAMBLE_NOT_FOUND', 'Preamble not found', 404);
  }
}

function normalizeCreatedPreamble(value: unknown): Preamble {
  const preamble = normalizePreamble(value);
  if (!preamble) {
    throw new PreambleDomainError(
      'PREAMBLE_VALIDATION_FAILED',
      'Preamble is invalid',
      500,
    );
  }
  return preamble;
}

async function assertCanonicalProjectPaths(preambles: readonly Preamble[]): Promise<void> {
  const projectPaths = new Set(preambles.flatMap((preamble) => preamble.scope.type === 'project-paths'
    ? preamble.scope.rules.map((rule) => rule.projectPath)
    : []));
  await Promise.all([...projectPaths].map(async (projectPath) => {
    let canonicalProjectPath: string;
    try {
      canonicalProjectPath = await assertRealWithinProjectBase(projectPath);
    } catch (error) {
      throw new Error('preambles.json contains a non-canonical project path', { cause: error });
    }
    if (canonicalProjectPath === projectPath) return;
    throw new Error('preambles.json contains a non-canonical project path');
  }));
}

export function reorderedPreambles(
  preambles: readonly Preamble[],
  orderedIds: readonly string[],
): Preamble[] | null {
  if (
    orderedIds.length !== preambles.length
    || orderedIds.some((id) => typeof id !== 'string')
    || new Set(orderedIds).size !== orderedIds.length
  ) return null;
  const byId = new Map(preambles.map((preamble) => [preamble.id, preamble]));
  const reordered = orderedIds.map((id) => byId.get(id));
  return reordered.every((entry): entry is Preamble => entry !== undefined)
    ? reordered
    : null;
}

function nextUpdatedAt(current: string, candidate: string): string {
  return new Date(Math.max(Date.parse(candidate), Date.parse(current) + 1)).toISOString();
}
