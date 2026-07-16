import crypto from 'crypto';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import {
  normalizeExpandSnippetRequest,
  normalizeSnippetDefinitionInput,
  type CreateSnippetRequest,
  type ExpandSnippetRequest,
  type ExpandSnippetResponse,
  type ReorderSnippetsRequest,
  type RemoveSnippetRequest,
  type Snippet,
  type SnippetExpansionContext,
  type SnippetsInvalidationReason,
  type SnippetsSnapshot,
  type UpdateSnippetRequest,
} from '../../common/snippets.js';
import type { IChatRegistry } from '../chats/store.js';
import {
  assertRealWithinProjectBase,
  isProjectBoundaryError,
} from '../lib/path-boundary.js';
import { SnippetDomainError } from './errors.js';
import { SnippetStore } from './store.js';
import { expandSnippetTemplate, SnippetExpansionError } from './template.js';

function projectPathAccessError(
  error: unknown,
  projectPath: string,
): SnippetDomainError | null {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    return new SnippetDomainError(
      'SNIPPET_PROJECT_PATH_NOT_FOUND',
      `Project path not found: ${projectPath}`,
      404,
    );
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new SnippetDomainError(
      'SNIPPET_PROJECT_PATH_INACCESSIBLE',
      `Project path is not accessible: ${projectPath}`,
      403,
    );
  }
  return null;
}

export class SnippetProjectPathService {
  async resolve(projectPath: string): Promise<string> {
    const requestedPath = projectPath.trim();
    if (!requestedPath) {
      throw new SnippetDomainError(
        'SNIPPET_PROJECT_PATH_REQUIRED',
        'Project path is required',
        400,
      );
    }

    let canonicalPath: string;
    try {
      canonicalPath = await assertRealWithinProjectBase(requestedPath);
    } catch (error) {
      if (isProjectBoundaryError(error)) {
        throw new SnippetDomainError(
          'SNIPPET_PROJECT_PATH_OUTSIDE_BASE',
          'Project path is outside the allowed base directory',
          403,
        );
      }
      const accessError = projectPathAccessError(error, requestedPath);
      if (accessError) throw accessError;
      throw error;
    }

    let projectStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      projectStat = await fs.stat(canonicalPath);
    } catch (error) {
      const accessError = projectPathAccessError(error, canonicalPath);
      if (accessError) throw accessError;
      throw error;
    }
    if (!projectStat.isDirectory()) {
      throw new SnippetDomainError(
        'SNIPPET_PROJECT_PATH_NOT_DIRECTORY',
        `Project path is not a directory: ${canonicalPath}`,
        400,
      );
    }
    return canonicalPath;
  }
}

interface SnippetServiceDeps {
  store: SnippetStore;
  chats: Pick<IChatRegistry, 'getChat'>;
  projectPaths: Pick<SnippetProjectPathService, 'resolve'>;
  newId?: () => string;
  now?: () => Date;
}

export class SnippetService extends EventEmitter {
  constructor(private readonly deps: SnippetServiceDeps) {
    super();
  }

  onInvalidated(callback: (reason: SnippetsInvalidationReason) => void): void {
    this.on('invalidated', callback);
  }

  snapshot(): SnippetsSnapshot {
    return this.deps.store.snapshot();
  }

  async create(request: CreateSnippetRequest): Promise<SnippetsSnapshot> {
    const definition = this.#definition(request.snippet);
    const now = this.#now().toISOString();
    const snippet: Snippet = {
      id: this.#newId(),
      ...definition,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.create(snippet, request.expectedRevision);
    this.#emitInvalidated('created');
    return this.snapshot();
  }

  async update(request: UpdateSnippetRequest): Promise<SnippetsSnapshot> {
    const id = request.id.trim();
    if (!id) throw this.#validationError();
    const definition = this.#definition(request.snippet);
    await this.deps.store.update(
      id,
      definition,
      this.#now().toISOString(),
      request.expectedRevision,
    );
    this.#emitInvalidated('updated');
    return this.snapshot();
  }

  async remove(request: RemoveSnippetRequest): Promise<SnippetsSnapshot> {
    const id = request.id.trim();
    if (!id) throw this.#validationError();
    await this.deps.store.remove(id, request.expectedRevision);
    this.#emitInvalidated('removed');
    return this.snapshot();
  }

  async reorder(request: ReorderSnippetsRequest): Promise<SnippetsSnapshot> {
    await this.deps.store.reorder(
      request.orderedSnippetIds,
      request.expectedRevision,
    );
    this.#emitInvalidated('reordered');
    return this.snapshot();
  }

  async expand(request: ExpandSnippetRequest): Promise<ExpandSnippetResponse> {
    const input = normalizeExpandSnippetRequest(request);
    if (!input) throw this.#validationError();
    const snippet = this.deps.store.getByShortName(input.shortName);
    if (!snippet) {
      throw new SnippetDomainError(
        'SNIPPET_NOT_FOUND',
        `Snippet not found: ${input.shortName}`,
        404,
      );
    }
    const { contextProjectPath, resolvedProjectPath } =
      await this.#resolveProjectPath(input.context);
    let expandedText: string;
    try {
      expandedText = expandSnippetTemplate(snippet.template, {
        arguments: input.arguments,
        projectPath: resolvedProjectPath,
      });
    } catch (error) {
      if (error instanceof SnippetExpansionError) {
        throw new SnippetDomainError(error.code, error.message, 422);
      }
      throw error;
    }
    return {
      success: true,
      snippetId: snippet.id,
      snippetUpdatedAt: snippet.updatedAt,
      shortName: snippet.shortName,
      contextProjectPath,
      expandedText,
    };
  }

  #definition(value: unknown) {
    const definition = normalizeSnippetDefinitionInput(value);
    if (!definition) throw this.#validationError();
    return definition;
  }

  async #resolveProjectPath(context: SnippetExpansionContext): Promise<{
    contextProjectPath: string;
    resolvedProjectPath: string;
  }> {
    if (context.type === 'project') {
      return {
        contextProjectPath: context.projectPath,
        resolvedProjectPath: await this.deps.projectPaths.resolve(
          context.projectPath,
        ),
      };
    }
    const chat = this.deps.chats.getChat(context.chatId);
    const contextProjectPath = chat?.projectPath.trim();
    if (!contextProjectPath) {
      throw new SnippetDomainError(
        'SNIPPET_CHAT_NOT_FOUND',
        'Chat not found or missing project path',
        404,
      );
    }
    return {
      contextProjectPath,
      resolvedProjectPath: await this.deps.projectPaths.resolve(
        contextProjectPath,
      ),
    };
  }

  #validationError(): SnippetDomainError {
    return new SnippetDomainError(
      'SNIPPET_VALIDATION_FAILED',
      'Snippet is invalid',
      400,
    );
  }

  #emitInvalidated(reason: SnippetsInvalidationReason): void {
    this.emit('invalidated', reason);
  }

  #newId(): string {
    return (this.deps.newId ?? crypto.randomUUID)();
  }

  #now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
