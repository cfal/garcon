import path from 'path';
import {
  SNIPPET_MAX_COUNT,
  normalizeSnippet,
  type Snippet,
  type SnippetDefinitionInput,
  type SnippetsSnapshot,
} from '../../common/snippets.js';
import { JsonFileStore } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { SnippetDomainError } from './errors.js';

interface SnippetsFile {
  version: 1;
  revision: number;
  snippets: Snippet[];
}

function emptyFile(): SnippetsFile {
  return { version: 1, revision: 0, snippets: [] };
}

function normalizeFile(value: unknown): SnippetsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return emptyFile();
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error(
      `Unsupported snippets.json version: ${String(raw.version)}`,
    );
  }
  const revision =
    typeof raw.revision === 'number' &&
    Number.isSafeInteger(raw.revision) &&
    raw.revision >= 0
      ? raw.revision
      : 0;
  const snippets: Snippet[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  if (Array.isArray(raw.snippets)) {
    for (const value of raw.snippets) {
      const snippet = normalizeSnippet(value);
      if (!snippet || ids.has(snippet.id) || names.has(snippet.shortName)) {
        continue;
      }
      if (snippets.length >= SNIPPET_MAX_COUNT) {
        throw new Error(
          `snippets.json exceeds the maximum of ${SNIPPET_MAX_COUNT} snippets`,
        );
      }
      ids.add(snippet.id);
      names.add(snippet.shortName);
      snippets.push(snippet);
    }
  }
  return { version: 1, revision, snippets };
}

function cloneSnippet(snippet: Snippet): Snippet {
  return structuredClone(snippet);
}

export class SnippetStore {
  readonly #persistence: JsonFileStore<SnippetsFile>;
  readonly #lock = new KeyedPromiseLock();
  #file = emptyFile();

  constructor(workspaceDir: string) {
    this.#persistence = new JsonFileStore({
      filePath: path.join(workspaceDir, 'snippets.json'),
      mode: 0o600,
      empty: emptyFile,
      normalize: normalizeFile,
    });
  }

  async init(): Promise<void> {
    this.#file = await this.#persistence.read();
  }

  snapshot(): SnippetsSnapshot {
    return {
      revision: this.#file.revision,
      snippets: this.#file.snippets.map(cloneSnippet),
    };
  }

  getByShortName(shortName: string): Snippet | null {
    const snippet = this.#file.snippets.find(
      (entry) => entry.shortName === shortName,
    );
    return snippet ? cloneSnippet(snippet) : null;
  }

  async create(snippet: Snippet, expectedRevision: number): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      if (draft.snippets.length >= SNIPPET_MAX_COUNT) {
        throw new SnippetDomainError(
          'SNIPPET_LIMIT_REACHED',
          `A maximum of ${SNIPPET_MAX_COUNT} snippets is allowed`,
          409,
        );
      }
      if (
        draft.snippets.some((entry) => entry.shortName === snippet.shortName)
      ) {
        throw new SnippetDomainError(
          'SNIPPET_NAME_CONFLICT',
          `A snippet named ${snippet.shortName} already exists`,
          409,
        );
      }
      if (draft.snippets.some((entry) => entry.id === snippet.id)) {
        throw new SnippetDomainError(
          'SNIPPET_VALIDATION_FAILED',
          'Snippet ID already exists',
          409,
        );
      }
      draft.snippets.push(cloneSnippet(snippet));
    });
  }

  async update(
    id: string,
    definition: SnippetDefinitionInput,
    updatedAt: string,
    expectedRevision: number,
  ): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      const index = draft.snippets.findIndex((entry) => entry.id === id);
      if (index < 0) throw this.#notFound();
      if (
        draft.snippets.some(
          (entry) =>
            entry.id !== id && entry.shortName === definition.shortName,
        )
      ) {
        throw new SnippetDomainError(
          'SNIPPET_NAME_CONFLICT',
          `A snippet named ${definition.shortName} already exists`,
          409,
        );
      }
      draft.snippets[index] = {
        ...draft.snippets[index],
        ...structuredClone(definition),
        updatedAt,
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

  async reorder(
    orderedSnippetIds: string[],
    expectedRevision: number,
  ): Promise<void> {
    await this.#mutate(expectedRevision, (draft) => {
      const currentIds = draft.snippets.map((snippet) => snippet.id);
      const supplied = new Set(orderedSnippetIds);
      if (
        orderedSnippetIds.length !== currentIds.length ||
        supplied.size !== orderedSnippetIds.length ||
        currentIds.some((id) => !supplied.has(id))
      ) {
        throw new SnippetDomainError(
          'SNIPPET_VALIDATION_FAILED',
          'orderedSnippetIds must contain every current snippet exactly once',
          400,
        );
      }
      const byId = new Map(
        draft.snippets.map((snippet) => [snippet.id, snippet]),
      );
      draft.snippets = orderedSnippetIds.map((id) => byId.get(id)!);
    });
  }

  async #mutate(
    expectedRevision: number,
    change: (draft: SnippetsFile) => void,
  ): Promise<void> {
    await this.#lock.runExclusive('snippets', async () => {
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
      draft.revision += 1;
      await this.#persistence.write(draft);
      this.#file = draft;
    });
  }

  #notFound(): SnippetDomainError {
    return new SnippetDomainError(
      'SNIPPET_NOT_FOUND',
      'Snippet not found',
      404,
    );
  }
}
