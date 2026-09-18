import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { ProjectInspector } from '../../common/project-resolution.js';
import {
  normalizeExpandSnippetRequest,
  normalizeSnippetDefinitionInput,
  type CreateSnippetRequest,
  type ExpandSnippetRequest,
  type ExpandSnippetResponse,
  type RemoveSnippetRequest,
  type Snippet,
  type SnippetExpansionContext,
  type SnippetsInvalidationReason,
  type SnippetsSnapshot,
  type UpdateSnippetRequest,
} from '../../common/snippets.js';
import { renderPreambleContent } from '../../common/preambles.js';
import type { IChatRegistry } from '../chats/store.js';
import { SnippetDomainError } from './errors.js';
import { SnippetCatalogCommittedUnknownError, SnippetStore } from './store.js';
import { expandSnippetTemplate, SnippetExpansionError } from './template.js';
import type { PreambleStore } from '../preambles/store.js';
import type {
  AssertSnippetShortNameAvailable,
  SnippetShortNameCoordinator,
} from './short-name-coordinator.js';

export class SnippetProjectPathService {
  constructor(private readonly inspect: ProjectInspector) {}

  async resolve(projectPath: string): Promise<string> {
    const requestedPath = projectPath.trim();
    if (!requestedPath) {
      throw new SnippetDomainError(
        'SNIPPET_PROJECT_PATH_REQUIRED',
        'Project path is required',
        400,
      );
    }

    const resolution = await this.inspect(requestedPath);
    if (resolution.kind === 'available') return resolution.effectiveProjectKey;
    switch (resolution.reason) {
      case 'not-found':
        throw new SnippetDomainError('SNIPPET_PROJECT_PATH_NOT_FOUND', `Project path not found: ${requestedPath}`, 404);
      case 'outside-base':
        throw new SnippetDomainError('SNIPPET_PROJECT_PATH_OUTSIDE_BASE', 'Project path is outside the allowed base directory', 403);
      case 'not-a-directory':
        throw new SnippetDomainError('SNIPPET_PROJECT_PATH_NOT_DIRECTORY', `Project path is not a directory: ${requestedPath}`, 400);
      case 'permission-denied':
        throw new SnippetDomainError('SNIPPET_PROJECT_PATH_INACCESSIBLE', `Project path is not accessible: ${requestedPath}`, 403);
    }
  }
}

interface SnippetServiceDeps {
  store: SnippetStore;
  preambles?: Pick<PreambleStore, 'getBySnippetShortName'>;
  snippetShortNames?: Pick<SnippetShortNameCoordinator, 'runMutation'>;
  chats: Pick<IChatRegistry, 'getChat'>;
  projectPaths: Pick<SnippetProjectPathService, 'resolve'>;
  newId?: () => string;
  now?: () => Date;
}

interface SnippetServiceEvents {
  invalidated: [reason: SnippetsInvalidationReason];
}

export class SnippetService extends EventEmitter<SnippetServiceEvents> {
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
    return this.#mutate(
      'created',
      () => this.#runShortNameMutation((assertAvailable) =>
        this.deps.store.create(
          snippet,
          request.expectedRevision,
          () => this.#assertShortNameAvailable(assertAvailable, snippet.shortName),
        ),
      ),
    );
  }

  async update(request: UpdateSnippetRequest): Promise<SnippetsSnapshot> {
    const id = request.id.trim();
    if (!id) throw this.#validationError();
    const definition = this.#definition(request.snippet);
    return this.#mutate(
      'updated',
      () => this.#runShortNameMutation((assertAvailable) =>
        this.deps.store.update(
          id,
          definition,
          this.#now().toISOString(),
          request.expectedRevision,
          () => this.#assertShortNameAvailable(assertAvailable, definition.shortName, id),
        ),
      ),
    );
  }

  async remove(request: RemoveSnippetRequest): Promise<SnippetsSnapshot> {
    const id = request.id.trim();
    if (!id) throw this.#validationError();
    return this.#mutate(
      'removed',
      () => this.#runShortNameMutation(() =>
        this.deps.store.remove(id, request.expectedRevision)),
    );
  }

  async expand(request: ExpandSnippetRequest): Promise<ExpandSnippetResponse> {
    const input = normalizeExpandSnippetRequest(request);
    if (!input) throw this.#validationError();
    const snippet = this.deps.store.getByShortName(input.shortName);
    const preamble = snippet
      ? null
      : this.deps.preambles?.getBySnippetShortName(input.shortName) ?? null;
    if (!snippet && !preamble) {
      throw new SnippetDomainError(
        'SNIPPET_NOT_FOUND',
        `Snippet not found: ${input.shortName}`,
        404,
      );
    }
    const { contextProjectPath, resolvedProjectPath } = await this.#resolveProjectPath(
      input.context,
    );
    let expandedText: string;
    if (snippet) {
      const argumentsText =
        input.arguments.type === 'default' ? snippet.defaultArguments : input.arguments.value;
      try {
        expandedText = expandSnippetTemplate(snippet.template, {
          arguments: argumentsText,
          projectPath: resolvedProjectPath,
          chatId: input.context.chatId,
        });
      } catch (error) {
        if (error instanceof SnippetExpansionError) {
          throw new SnippetDomainError(error.code, error.message, 422);
        }
        throw error;
      }
    } else {
      expandedText = renderPreambleContent(preamble!.content, input.context.chatId);
    }
    return {
      success: true,
      source: snippet ? 'snippet' : 'preamble',
      sourceId: (snippet ?? preamble)!.id,
      sourceUpdatedAt: (snippet ?? preamble)!.updatedAt,
      shortName: snippet?.shortName ?? preamble!.snippetShortName!,
      contextProjectPath,
      expandedText,
    };
  }

  #runShortNameMutation<T>(
    mutate: (assertAvailable: AssertSnippetShortNameAvailable) => Promise<T>,
  ): Promise<T> {
    const coordinator = this.deps.snippetShortNames;
    if (coordinator) return coordinator.runMutation(mutate);
    return mutate(() => {});
  }

  async #mutate(
    reason: SnippetsInvalidationReason,
    run: () => Promise<void>,
  ): Promise<SnippetsSnapshot> {
    try {
      await run();
    } catch (error) {
      if (error instanceof SnippetCatalogCommittedUnknownError) {
        this.#emitInvalidated(reason);
        throw new SnippetDomainError(
          'SNIPPET_CATALOG_SAVE_UNKNOWN',
          'The snippets catalog was saved, but its durability could not be confirmed. Restart the server before further catalog changes.',
          503,
        );
      }
      throw error;
    }
    this.#emitInvalidated(reason);
    return this.snapshot();
  }

  #assertShortNameAvailable(
    assertAvailable: AssertSnippetShortNameAvailable,
    shortName: string,
    id?: string,
  ): void {
    assertAvailable(
      shortName,
      id ? { type: 'snippet', id } : undefined,
      (conflictingName) => new SnippetDomainError(
        'SNIPPET_NAME_CONFLICT',
        `A snippet named ${conflictingName} already exists`,
        409,
      ),
    );
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
    if (context.type === 'new-chat') {
      return {
        contextProjectPath: context.projectPath,
        resolvedProjectPath: await this.deps.projectPaths.resolve(context.projectPath),
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
      resolvedProjectPath: await this.deps.projectPaths.resolve(contextProjectPath),
    };
  }

  #validationError(): SnippetDomainError {
    return new SnippetDomainError('SNIPPET_VALIDATION_FAILED', 'Snippet is invalid', 400);
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
