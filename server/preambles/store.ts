import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PREAMBLE_MAX_COUNT,
  normalizePreamble,
  type Preamble,
  type PreambleDefinitionInput,
  type PreamblesSnapshot,
} from '../../common/preambles.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { assertRealWithinProjectBase } from '../lib/path-boundary.js';
import { PreambleDomainError } from './errors.js';
import { preambleCatalogCompositionViolation } from './catalog-budget.js';

const PREAMBLES_FILE_VERSION = 1;

interface PreamblesFile {
  readonly version: typeof PREAMBLES_FILE_VERSION;
  revision: number;
  preambles: Preamble[];
}

function emptyFile(): PreamblesFile {
  return { version: PREAMBLES_FILE_VERSION, revision: 0, preambles: [] };
}

function normalizeFile(value: unknown): PreamblesFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('preambles.json must contain an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== PREAMBLES_FILE_VERSION) {
    throw new Error(`Unsupported preambles.json version: ${String(raw.version)}`);
  }
  if (
    Object.keys(raw).some((key) => !['version', 'revision', 'preambles'].includes(key))
    || !Number.isSafeInteger(raw.revision)
    || (raw.revision as number) < 0
    || !Array.isArray(raw.preambles)
    || raw.preambles.length > PREAMBLE_MAX_COUNT
  ) throw new Error('preambles.json is invalid');
  const ids = new Set<string>();
  const preambles = raw.preambles.map((valuePreamble) => {
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
  if (preambleCatalogCompositionViolation(preambles)) {
    throw new Error('preambles.json contains an invalid combined preamble composition');
  }
  return { version: PREAMBLES_FILE_VERSION, revision: raw.revision as number, preambles };
}

export class PreambleStore {
  readonly #filePath: string;
  readonly #lock = new KeyedPromiseLock();
  #file = emptyFile();

  constructor(workspaceDir: string) {
    this.#filePath = path.join(workspaceDir, 'preambles.json');
  }

  async init(): Promise<void> {
    try {
      const file = normalizeFile(JSON.parse(await fs.readFile(this.#filePath, 'utf8')));
      await assertCanonicalProjectPaths(file.preambles);
      this.#file = file;
    } catch (error) {
      if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
      this.#file = emptyFile();
    }
  }

  snapshot(): PreamblesSnapshot {
    return { revision: this.#file.revision, preambles: structuredClone(this.#file.preambles) };
  }

  async create(preamble: Preamble, expectedRevision: number): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      if (draft.preambles.length >= PREAMBLE_MAX_COUNT) {
        throw new PreambleDomainError(
          'PREAMBLE_LIMIT_REACHED',
          `A maximum of ${PREAMBLE_MAX_COUNT} preambles is allowed`,
          409,
        );
      }
      if (draft.preambles.some((entry) => entry.id === preamble.id)) {
        throw new PreambleDomainError('PREAMBLE_VALIDATION_FAILED', 'Preamble ID already exists', 409);
      }
      draft.preambles.push(structuredClone(preamble));
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
      draft.preambles.splice(index, 1);
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
      draft.revision += 1;
      await writeJsonFileAtomic(this.#filePath, draft, { mode: 0o600 });
      this.#file = draft;
    });
  }

  #notFound(): PreambleDomainError {
    return new PreambleDomainError('PREAMBLE_NOT_FOUND', 'Preamble not found', 404);
  }
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
