import { rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentChatReference,
  AgentHost,
  AgentSearchChat,
  AgentSearchGeneration,
  AgentTranscriptSearch,
} from '@garcon/server-agent-interface';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { ChatMessage } from '@garcon/common/chat-types';
import { stripFirstUserSeed } from '@garcon/common/transcript-seed';
import { projectHistoricalSearchMessages } from './message-projector.js';
import { searchIndexStatus, searchTranscriptIndex } from './query.js';
import {
  closeSearchDatabase,
  markChatStatus,
  openSearchDatabase,
  pruneMissingChats,
  replaceChatRows,
  loadPersistedGenerations,
  type SearchDatabase,
} from './schema.js';

export interface TranscriptSearchOptions {
  readonly agentId: string;
  readonly host: AgentHost;
  readonly loadTranscript: (request: {
    readonly chat: AgentSearchChat;
    readonly signal: AbortSignal;
  }) => Promise<readonly ChatMessage[]>;
}

export interface ClosableTranscriptSearch extends AgentTranscriptSearch {
  close(): Promise<void>;
}

export function createTranscriptSearch(options: TranscriptSearchOptions): ClosableTranscriptSearch {
  return new SqliteTranscriptSearch(options);
}

class SqliteTranscriptSearch implements ClosableTranscriptSearch {
  readonly #options: TranscriptSearchOptions;
  #database: SearchDatabase | null = null;
  #databaseDirectory: string | null = null;
  #state: 'disabled' | 'enabled' | 'cleaning' = 'disabled';
  #tail: Promise<void> = Promise.resolve();
  #acceptedGeneration: AgentSearchGeneration | null = null;
  #retiredEpochs = new Set<string>();
  #generationBases = new Map<string, number>();
  #acceptance = 0;

  constructor(options: TranscriptSearchOptions) {
    this.#options = options;
  }

  reconcile(request: Parameters<AgentTranscriptSearch['reconcile']>[0]): Promise<void> {
    if (!this.#acceptGeneration(request.generation)) return Promise.resolve();
    this.#state = 'enabled';
    const acceptance = ++this.#acceptance;
    return this.#serialize(async () => {
      request.signal.throwIfAborted();
      if (!this.#accepts(acceptance)) return;
      if (request.chats.length === 0) {
        if (this.#database) pruneMissingChats(this.#database.db, []);
        return;
      }
      const database = await this.#open();
      const generation = this.#databaseGeneration(database, request.generation);
      const currentIds = request.chats.map((chat) => chat.chatId);
      for (const chat of request.chats) {
        markChatStatus(database.db, chat.chatId, generation, 'pending');
      }
      for (const chat of request.chats) {
        request.signal.throwIfAborted();
        if (!this.#accepts(acceptance)) return;
        try {
          const nativeMessages = await this.#options.loadTranscript({ chat, signal: request.signal });
          const carried = await this.#loadCarryOver(chat, request.signal);
          if (!this.#accepts(acceptance)) return;
          const native = carried.length > 0 ? stripFirstUserSeed([...nativeMessages]) : nativeMessages;
          const messages = [...carried, ...native];
          const rows = projectHistoricalSearchMessages(messages);
          replaceChatRows(
            database.db,
            chat.chatId,
            generation,
            `${chat.transcriptRevision}:${chat.carryOverRevision}`,
            rows,
          );
        } catch (error) {
          if (request.signal.aborted) throw error;
          if (!this.#accepts(acceptance)) return;
          markChatStatus(
            database.db,
            chat.chatId,
            generation,
            'failed',
            error instanceof AgentIntegrationError ? error.code : 'TRANSCRIPT_UNAVAILABLE',
          );
        }
      }
      if (this.#accepts(acceptance)) pruneMissingChats(database.db, currentIds);
    });
  }

  search(request: Parameters<AgentTranscriptSearch['search']>[0]) {
    request.signal.throwIfAborted();
    if (this.#state !== 'enabled') {
      throw new AgentIntegrationError('SEARCH_DISABLED', 'Transcript search is disabled', false);
    }
    return this.#serialize(async () => {
      request.signal.throwIfAborted();
      if (request.chats.length === 0) return { hits: [], index: emptyStatus() };
      const database = await this.#open();
      request.signal.throwIfAborted();
      const raw = rawQuery(request.query);
      const result = searchTranscriptIndex(database.db, {
        query: raw.query,
        textTokens: raw.tokens,
        allowedChatIds: request.chats.map((chat) => chat.chatId),
        limit: request.limit,
      });
      return {
        hits: result.results.map(({ chatId, matchedMessageCount, snippets }) => ({
          chatId,
          matchedMessageCount,
          snippets,
        })),
        index: result.index,
      };
    });
  }

  async status(request: Parameters<AgentTranscriptSearch['status']>[0]) {
    request.signal.throwIfAborted();
    if (this.#state !== 'enabled') return emptyStatus();
    if (request.chats.length === 0 || !this.#database) return emptyStatus();
    return searchIndexStatus(this.#database.db, request.chats.map((chat) => chat.chatId));
  }

  disableAndDelete(request: Parameters<AgentTranscriptSearch['disableAndDelete']>[0]): Promise<void> {
    if (!this.#acceptGeneration(request.generation)) return Promise.resolve();
    this.#state = 'cleaning';
    ++this.#acceptance;
    return this.#serialize(async () => {
      request.signal.throwIfAborted();
      await this.#closeDatabase();
      const directory = this.#databaseDirectory
        ?? path.join(this.#options.host.storage.rootDirectory, 'transcript-search');
      request.signal.throwIfAborted();
      await rm(directory, { recursive: true, force: true });
      this.#databaseDirectory = null;
      this.#generationBases.clear();
      this.#state = 'disabled';
      request.signal.throwIfAborted();
    });
  }

  async close(): Promise<void> {
    await this.#serialize(() => this.#closeDatabase());
  }

  async #open(): Promise<SearchDatabase> {
    if (this.#database) return this.#database;
    const directory = await this.#options.host.storage.directory('transcript-search');
    this.#databaseDirectory = directory;
    this.#database = await openSearchDatabase(path.join(directory, 'index.sqlite'));
    return this.#database;
  }

  async #closeDatabase(): Promise<void> {
    if (!this.#database) return;
    const database = this.#database;
    this.#database = null;
    closeSearchDatabase(database.db);
  }

  async #loadCarryOver(chat: AgentSearchChat, signal: AbortSignal): Promise<readonly ChatMessage[]> {
    const result = await this.#options.host.carryOver.load({
      chatId: chat.chatId,
      expectedRevision: chat.carryOverRevision,
      currentAgentId: this.#options.agentId,
      currentModel: chat.model,
      signal,
    });
    if (result.revision !== chat.carryOverRevision) {
      throw new AgentIntegrationError('SOURCE_REVISION_CHANGED', 'Carry-over transcript changed', true);
    }
    return result.messages;
  }

  #acceptGeneration(generation: AgentSearchGeneration): boolean {
    const accepted = this.#acceptedGeneration;
    if (!accepted) {
      this.#acceptedGeneration = generation;
      return true;
    }
    if (accepted.epoch === generation.epoch) {
      if (generation.sequence < accepted.sequence) return false;
      this.#acceptedGeneration = generation;
      return true;
    }
    if (this.#retiredEpochs.has(generation.epoch)) return false;
    this.#retiredEpochs.add(accepted.epoch);
    this.#acceptedGeneration = generation;
    return true;
  }

  #databaseGeneration(
    database: SearchDatabase,
    generation: AgentSearchGeneration,
  ): number {
    let base = this.#generationBases.get(generation.epoch);
    if (base === undefined) {
      base = Math.max(0, ...loadPersistedGenerations(database.db).values());
      this.#generationBases.set(generation.epoch, base);
    }
    const value = base + generation.sequence;
    if (!Number.isSafeInteger(value)) {
      throw new Error('Transcript search generation exceeded the safe integer range');
    }
    return value;
  }

  #accepts(acceptance: number): boolean {
    return this.#state === 'enabled' && acceptance === this.#acceptance;
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function rawQuery(query: Parameters<AgentTranscriptSearch['search']>[0]['query']): {
  readonly query: string;
  readonly tokens: string[];
} {
  const tokens = query.clauses.map((clause) => clause.tokens.map((token) => token.text).join(' '));
  const text = query.clauses.map((clause, index) => (
    clause.kind === 'phrase' ? `"${tokens[index].replaceAll('"', '')}"` : tokens[index]
  )).join(' ');
  return { query: text, tokens };
}

function emptyStatus() {
  return {
    indexedChatCount: 0,
    pendingChatCount: 0,
    failedChatCount: 0,
    unsupportedChatCount: 0,
  };
}
