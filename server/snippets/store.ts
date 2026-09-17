import path from 'path';
import { promises as fs } from 'fs';
import {
  SNIPPET_MAX_COUNT,
  normalizeSnippet,
  sortSnippetsByShortName,
  type Snippet,
  type SnippetDefinitionInput,
  type SnippetsSnapshot,
} from '../../common/snippets.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { SnippetDomainError } from './errors.js';

const SNIPPETS_FILE_VERSION = 2;

interface SnippetsFile {
  version: typeof SNIPPETS_FILE_VERSION;
  revision: number;
  snippets: Snippet[];
}

interface NormalizedSnippetsFile {
  file: SnippetsFile;
  migrated: boolean;
}

function emptyFile(): SnippetsFile {
  return { version: SNIPPETS_FILE_VERSION, revision: 0, snippets: [] };
}

function normalizeV1Snippet(value: unknown): Snippet | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return normalizeSnippet({
    ...(value as Record<string, unknown>),
    defaultArguments: '',
  });
}

function normalizeFile(value: unknown): NormalizedSnippetsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { file: emptyFile(), migrated: false };
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 && raw.version !== SNIPPETS_FILE_VERSION) {
    throw new Error(`Unsupported snippets.json version: ${String(raw.version)}`);
  }
  const revision =
    typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0
      ? raw.revision
      : 0;
  const snippets: Snippet[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  if (Array.isArray(raw.snippets)) {
    for (const value of raw.snippets) {
      const snippet = raw.version === 1 ? normalizeV1Snippet(value) : normalizeSnippet(value);
      if (!snippet || ids.has(snippet.id) || names.has(snippet.shortName)) {
        continue;
      }
      if (snippets.length >= SNIPPET_MAX_COUNT) {
        throw new Error(`snippets.json exceeds the maximum of ${SNIPPET_MAX_COUNT} snippets`);
      }
      ids.add(snippet.id);
      names.add(snippet.shortName);
      snippets.push(snippet);
    }
  }
  return {
    file: {
      version: SNIPPETS_FILE_VERSION,
      revision,
      snippets: sortSnippetsByShortName(snippets),
    },
    migrated: raw.version === 1,
  };
}

async function readFile(filePath: string): Promise<NormalizedSnippetsFile> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return normalizeFile(JSON.parse(raw));
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return { file: emptyFile(), migrated: false };
    }
    throw error;
  }
}

function cloneSnippet(snippet: Snippet): Snippet {
  return structuredClone(snippet);
}

export class SnippetCatalogCommittedUnknownError extends Error {
  constructor(cause: unknown) {
    super('The snippets catalog was committed, but its durability could not be confirmed.', {
      cause,
    });
    this.name = 'SnippetCatalogCommittedUnknownError';
  }
}

export class SnippetStore {
  readonly #filePath: string;
  readonly #lock = new KeyedPromiseLock();
  #file = emptyFile();
  #mutationFence: 'clear' | 'unknown-durability' = 'clear';

  constructor(workspaceDir: string) {
    this.#filePath = path.join(workspaceDir, 'snippets.json');
  }

  async init(): Promise<void> {
    const loaded = await readFile(this.#filePath);
    if (loaded.migrated) await this.#write(loaded.file);
    this.#file = loaded.file;
    this.#mutationFence = 'clear';
  }

  snapshot(): SnippetsSnapshot {
    return {
      revision: this.#file.revision,
      snippets: this.#file.snippets.map(cloneSnippet),
    };
  }

  getByShortName(shortName: string): Snippet | null {
    const snippet = this.#file.snippets.find((entry) => entry.shortName === shortName);
    return snippet ? cloneSnippet(snippet) : null;
  }

  async create(
    snippet: Snippet,
    expectedRevision: number,
    validateShortName?: () => void,
  ): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      if (draft.snippets.length >= SNIPPET_MAX_COUNT) {
        throw new SnippetDomainError(
          'SNIPPET_LIMIT_REACHED',
          `A maximum of ${SNIPPET_MAX_COUNT} snippets is allowed`,
          409,
        );
      }
      if (draft.snippets.some((entry) => entry.shortName === snippet.shortName)) {
        throw new SnippetDomainError(
          'SNIPPET_NAME_CONFLICT',
          `A snippet named ${snippet.shortName} already exists`,
          409,
        );
      }
      if (draft.snippets.some((entry) => entry.id === snippet.id)) {
        throw new SnippetDomainError('SNIPPET_VALIDATION_FAILED', 'Snippet ID already exists', 409);
      }
      validateShortName?.();
      draft.snippets.push(cloneSnippet(snippet));
    });
  }

  async update(
    id: string,
    definition: SnippetDefinitionInput,
    updatedAt: string,
    expectedRevision: number,
    validateShortName?: () => void,
  ): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      const index = draft.snippets.findIndex((entry) => entry.id === id);
      if (index < 0) throw this.#notFound();
      if (
        draft.snippets.some((entry) => entry.id !== id && entry.shortName === definition.shortName)
      ) {
        throw new SnippetDomainError(
          'SNIPPET_NAME_CONFLICT',
          `A snippet named ${definition.shortName} already exists`,
          409,
        );
      }
      validateShortName?.();
      draft.snippets[index] = {
        ...draft.snippets[index],
        ...structuredClone(definition),
        updatedAt: nextUpdatedAt(draft.snippets[index].updatedAt, updatedAt),
      };
    });
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      const index = draft.snippets.findIndex((entry) => entry.id === id);
      if (index < 0) throw this.#notFound();
      draft.snippets.splice(index, 1);
    });
  }

  async #mutate(expectedRevision: number, change: (draft: SnippetsFile) => void): Promise<void> {
    await this.#lock.runExclusive('snippets', async () => {
      if (this.#mutationFence === 'unknown-durability') {
        throw new SnippetDomainError(
          'SNIPPET_CATALOG_SAVE_UNKNOWN',
          'The snippets catalog has an unconfirmed save; restart the server before further catalog changes.',
          503,
        );
      }
      if (expectedRevision !== this.#file.revision) {
        throw new SnippetDomainError(
          'SNIPPET_REVISION_CONFLICT',
          'Snippets changed in another client; refresh and try again',
          409,
          true,
        );
      }
      if (this.#file.revision === Number.MAX_SAFE_INTEGER) {
        throw new SnippetDomainError(
          'SNIPPET_REVISION_EXHAUSTED',
          'Snippet revision limit reached',
          409,
        );
      }
      const draft = structuredClone(this.#file);
      change(draft);
      draft.snippets = sortSnippetsByShortName(draft.snippets);
      draft.revision += 1;
      try {
        await this.#write(draft);
      } catch (error) {
        if (error instanceof SnippetCatalogCommittedUnknownError) {
          this.#file = draft;
          this.#mutationFence = 'unknown-durability';
        }
        throw error;
      }
      this.#file = draft;
    });
  }

  async #write(file: SnippetsFile): Promise<void> {
    try {
      await writeJsonFileAtomic(this.#filePath, file, { mode: 0o600 });
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) {
        throw new SnippetCatalogCommittedUnknownError(error);
      }
      throw error;
    }
  }

  #notFound(): SnippetDomainError {
    return new SnippetDomainError('SNIPPET_NOT_FOUND', 'Snippet not found', 404);
  }
}

function nextUpdatedAt(current: string, candidate: string): string {
  return new Date(Math.max(Date.parse(candidate), Date.parse(current) + 1)).toISOString();
}
