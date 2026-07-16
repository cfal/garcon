import { promises as fs } from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';
import type { ChatMessage } from '../../common/chat-types.js';
import type {
  ChatSearchIndexStatus,
  ChatSearchResult,
  ChatSearchSnippet,
  ChatSearchSnippetRole,
} from '../../common/chat-search.js';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';
import { isArtificialNativePath } from './artificial-native-path.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';

const logger = createLogger('chats:search-index');

const SCHEMA_VERSION = 2;
const MAX_BODY_CHARS = 64_000;
const MAX_EXTRACTED_VALUE_CHARS = 20_000;
const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;
const SNIPPETS_PER_CHAT = 3;
const DEFAULT_REINDEX_DEBOUNCE_MS = 250;

interface ChatSearchIndexDeps {
  dbPath: string;
  registry: IChatRegistry;
  loadNativeMessages(chatId: string): Promise<ChatMessage[]>;
  now?: () => Date;
  reindexDebounceMs?: number;
}

interface SearchOptions {
  query: string;
  textTokens?: string[];
  allowedChatIds: string[];
  limit?: number;
}

interface IndexedMessageChunk {
  messageOrdinal: number;
  role: ChatSearchSnippetRole;
  timestamp: string | null;
  body: string;
}

interface SearchRow {
  rowId: number;
  chatId: string;
  messageOrdinal: number;
  role: ChatSearchSnippetRole;
  timestamp: string | null;
  matchedMessageCount: number;
}

interface SnippetRow {
  rowId: number;
  snippet: string;
}

interface ChatMatchRow {
  chatId: string;
  rank: number;
}

interface ActiveReindex {
  revision: number;
  task: Promise<void> | null;
}

export class ChatSearchIndex {
  #deps: ChatSearchIndexDeps;
  #db: Database | null = null;
  #appendRevisions = new Map<string, number>();
  #activeReindexes = new Map<string, ActiveReindex>();
  #reindexTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #reindexTask: Promise<void> | null = null;

  constructor(deps: ChatSearchIndexDeps) {
    this.#deps = deps;
  }

  async init(): Promise<void> {
    if (this.#deps.dbPath !== ':memory:') {
      await fs.mkdir(path.dirname(this.#deps.dbPath), { recursive: true });
    }
    const db = new Database(this.#deps.dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_search_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_search_state (
        chat_id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_search_chunks USING fts5(
        chat_id UNINDEXED,
        message_ordinal UNINDEXED,
        role UNINDEXED,
        timestamp UNINDEXED,
        body,
        tokenize = 'unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_search_documents USING fts5(
        chat_id UNINDEXED,
        body,
        tokenize = 'unicode61'
      );
    `);
    const storedSchemaVersion = db.query<{ value: string }, []>(`
      SELECT value FROM chat_search_meta WHERE key = 'schema_version'
    `).get()?.value;
    if (storedSchemaVersion !== String(SCHEMA_VERSION)) {
      db.exec(`
        DELETE FROM chat_search_state;
        DELETE FROM chat_search_chunks;
        DELETE FROM chat_search_documents;
      `);
    }
    db.query(`
      INSERT INTO chat_search_meta (key, value)
      VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SCHEMA_VERSION));
    this.#db = db;
  }

  reindexStaleChats(): Promise<void> {
    if (this.#reindexTask) return this.#reindexTask;
    const task = this.#reindexStaleChats();
    this.#reindexTask = task;
    return task.finally(() => {
      if (this.#reindexTask === task) this.#reindexTask = null;
    });
  }

  async #reindexStaleChats(): Promise<void> {
    const sessions = this.#deps.registry.listAllChats();
    for (const [chatId, session] of Object.entries(sessions)) {
      await this.#startReindex(chatId, session);
    }
    this.#pruneMissingChats();
  }

  #startReindex(chatId: string, session: ChatRegistryEntry): Promise<void> {
    const active = this.#activeReindexes.get(chatId);
    if (active?.task) return active.task;

    this.#clearReindexTimer(chatId);
    const attempt: ActiveReindex = {
      revision: this.#appendRevisions.get(chatId) ?? 0,
      task: null,
    };
    this.#activeReindexes.set(chatId, attempt);
    const task = this.#runReindex(chatId, session, attempt).finally(() => {
      if (this.#activeReindexes.get(chatId) === attempt) {
        this.#activeReindexes.delete(chatId);
      }
    });
    attempt.task = task;
    return task;
  }

  async #runReindex(
    chatId: string,
    session: ChatRegistryEntry,
    attempt: ActiveReindex,
  ): Promise<void> {
    try {
      const sourceKey = await this.#sourceKeyForSession(session);
      if (this.#activeReindexes.get(chatId) !== attempt) return;
      if (this.#stateSourceKey(chatId) === sourceKey) return;
      this.#deleteState(chatId);

      const messages = await this.#deps.loadNativeMessages(chatId);
      if (this.#activeReindexes.get(chatId) !== attempt) return;
      if ((this.#appendRevisions.get(chatId) ?? 0) !== attempt.revision) {
        this.#scheduleReindex(chatId);
        return;
      }

      this.#replaceChunks(chatId, messagesToChunks(messages), sourceKey);
    } catch (error) {
      logger.warn(`search-index: failed to index chat ${chatId}:`, errorMessage(error));
    }
  }

  #scheduleReindex(chatId: string): void {
    this.#clearReindexTimer(chatId);
    const timer = setTimeout(() => {
      if (this.#reindexTimers.get(chatId) !== timer) return;
      this.#reindexTimers.delete(chatId);
      const session = this.#deps.registry.listAllChats()[chatId];
      if (!session) return;
      void this.#startReindex(chatId, session);
    }, this.#deps.reindexDebounceMs ?? DEFAULT_REINDEX_DEBOUNCE_MS);
    timer.unref?.();
    this.#reindexTimers.set(chatId, timer);
  }

  #clearReindexTimer(chatId: string): void {
    const timer = this.#reindexTimers.get(chatId);
    if (!timer) return;
    clearTimeout(timer);
    this.#reindexTimers.delete(chatId);
  }

  replaceMessages(
    chatId: string,
    messages: ChatMessage[],
    options: { sourceKey?: string } = {},
  ): void {
    this.#appendRevisions.set(chatId, (this.#appendRevisions.get(chatId) ?? 0) + 1);
    this.#clearReindexTimer(chatId);
    this.#activeReindexes.delete(chatId);
    const chunks = messagesToChunks(messages);
    const sourceKey = options.sourceKey ?? this.#stateSourceKey(chatId) ?? 'live';
    this.#replaceChunks(chatId, chunks, sourceKey);
  }

  appendMessages(chatId: string, messages: ChatMessage[]): void {
    if (messages.length === 0) return;
    this.#appendRevisions.set(chatId, (this.#appendRevisions.get(chatId) ?? 0) + 1);
    if (this.#reindexTimers.has(chatId)) {
      this.#scheduleReindex(chatId);
    }

    const chunks = messagesToChunks(messages);
    if (chunks.length > 0) {
      const db = this.#requireDb();
      const currentMax = db.query<{ value: number | null }, [string]>(`
        SELECT MAX(CAST(message_ordinal AS INTEGER)) AS value
        FROM chat_search_chunks
        WHERE chat_id = ?
      `).get(chatId)?.value ?? 0;
      const offsetChunks = chunks.map((chunk, index) => ({
        ...chunk,
        messageOrdinal: currentMax + index + 1,
      }));
      const sourceKey = this.#stateSourceKey(chatId);

      db.exec('BEGIN IMMEDIATE');
      try {
        this.#insertChunks(chatId, offsetChunks);
        this.#rebuildDocument(chatId);
        if (sourceKey) this.#upsertState(chatId, sourceKey, this.#nowIso());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  deleteChat(chatId: string): void {
    this.#clearReindexTimer(chatId);
    this.#activeReindexes.delete(chatId);
    this.#appendRevisions.delete(chatId);
    const db = this.#requireDb();
    db.query('DELETE FROM chat_search_chunks WHERE chat_id = ?').run(chatId);
    db.query('DELETE FROM chat_search_documents WHERE chat_id = ?').run(chatId);
    db.query('DELETE FROM chat_search_state WHERE chat_id = ?').run(chatId);
  }

  search(options: SearchOptions): { results: ChatSearchResult[]; index: ChatSearchIndexStatus } {
    const allowedChatIds = uniqueStrings(options.allowedChatIds);
    if (allowedChatIds.length === 0) {
      return { results: [], index: { indexedChatCount: 0, pendingChatCount: 0 } };
    }
    return this.#withAllowedChats(allowedChatIds, () => {
      const index = this.#indexStatusForAllowed(allowedChatIds.length);
      const tokens = options.textTokens?.length ? options.textTokens : [options.query];
      const matchQuery = buildFtsQuery(tokens);
      if (!matchQuery) return { results: [], index };

      const chatRows = this.#requireDb().query<ChatMatchRow, [string, number]>(`
        SELECT
          chat_search_documents.chat_id AS chatId,
          bm25(chat_search_documents) AS rank
        FROM chat_search_documents
        JOIN temp_search_allowed ON temp_search_allowed.chat_id = chat_search_documents.chat_id
        WHERE chat_search_documents MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(matchQuery, clampLimit(options.limit));
      const results = this.#buildResults(chatRows, buildSnippetFtsQuery(tokens));
      return { results, index };
    });
  }

  indexStatus(allowedChatIds: string[]): ChatSearchIndexStatus {
    const uniqueAllowed = uniqueStrings(allowedChatIds);
    if (uniqueAllowed.length === 0) return { indexedChatCount: 0, pendingChatCount: 0 };
    return this.#withAllowedChats(uniqueAllowed, () => this.#indexStatusForAllowed(uniqueAllowed.length));
  }

  #requireDb(): Database {
    if (!this.#db) throw new Error('ChatSearchIndex not initialized');
    return this.#db;
  }

  #insertChunks(chatId: string, chunks: IndexedMessageChunk[]): void {
    const db = this.#requireDb();
    const insert = db.query(`
      INSERT INTO chat_search_chunks (chat_id, message_ordinal, role, timestamp, body)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const chunk of chunks) {
      insert.run(chatId, chunk.messageOrdinal, chunk.role, chunk.timestamp, chunk.body);
    }
  }

  #replaceChunks(chatId: string, chunks: IndexedMessageChunk[], sourceKey: string): void {
    const db = this.#requireDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.query('DELETE FROM chat_search_chunks WHERE chat_id = ?').run(chatId);
      this.#insertChunks(chatId, chunks);
      this.#replaceDocument(chatId, chunks.map((chunk) => chunk.body).join(' '));
      this.#upsertState(chatId, sourceKey, this.#nowIso());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  #replaceDocument(chatId: string, body: string): void {
    const db = this.#requireDb();
    db.query('DELETE FROM chat_search_documents WHERE chat_id = ?').run(chatId);
    if (!body) return;
    db.query('INSERT INTO chat_search_documents (chat_id, body) VALUES (?, ?)').run(chatId, body);
  }

  #rebuildDocument(chatId: string): void {
    const body = this.#requireDb().query<{ body: string | null }, [string]>(`
      SELECT GROUP_CONCAT(body, ' ') AS body
      FROM chat_search_chunks
      WHERE chat_id = ?
    `).get(chatId)?.body ?? '';
    this.#replaceDocument(chatId, body);
  }

  #buildResults(chatRows: ChatMatchRow[], snippetQuery: string): ChatSearchResult[] {
    if (chatRows.length === 0) return [];
    const db = this.#requireDb();
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS temp_search_matches (
        chat_id TEXT PRIMARY KEY
      ) WITHOUT ROWID
    `);
    db.query('DELETE FROM temp_search_matches').run();
    const insert = db.query('INSERT INTO temp_search_matches (chat_id) VALUES (?)');
    for (const row of chatRows) insert.run(row.chatId);

    // Bounds snippet generation and JS row materialization for common terms.
    const rows = db.query<SearchRow, [string, number]>(`
      SELECT rowId, chatId, messageOrdinal, role, timestamp, matchedMessageCount
      FROM (
        SELECT
          chat_search_chunks.rowid AS rowId,
          chat_search_chunks.chat_id AS chatId,
          CAST(message_ordinal AS INTEGER) AS messageOrdinal,
          role,
          timestamp,
          COUNT(*) OVER (PARTITION BY chat_search_chunks.chat_id) AS matchedMessageCount,
          ROW_NUMBER() OVER (
            PARTITION BY chat_search_chunks.chat_id
            ORDER BY rank, CAST(message_ordinal AS INTEGER)
          ) AS snippetRank
        FROM chat_search_chunks
        JOIN temp_search_matches ON temp_search_matches.chat_id = chat_search_chunks.chat_id
        WHERE chat_search_chunks MATCH ?
      )
      WHERE snippetRank <= ?
      ORDER BY chatId, snippetRank
    `).all(snippetQuery, SNIPPETS_PER_CHAT);

    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS temp_search_snippet_rows (
        row_id INTEGER PRIMARY KEY
      )
    `);
    db.query('DELETE FROM temp_search_snippet_rows').run();
    const insertSnippetRow = db.query('INSERT INTO temp_search_snippet_rows (row_id) VALUES (?)');
    for (const row of rows) insertSnippetRow.run(row.rowId);
    const snippets = db.query<SnippetRow, [string]>(`
      SELECT
        chat_search_chunks.rowid AS rowId,
        snippet(chat_search_chunks, 4, '', '', ' ... ', 32) AS snippet
      FROM chat_search_chunks
      JOIN temp_search_snippet_rows ON temp_search_snippet_rows.row_id = chat_search_chunks.rowid
      WHERE chat_search_chunks MATCH ?
    `).all(snippetQuery);
    const snippetTextByRow = new Map(
      snippets.map((row) => [Number(row.rowId), normalizeSnippet(row.snippet)]),
    );
    const snippetsByChat = new Map<string, ChatSearchSnippet[]>();
    const matchedMessageCounts = new Map<string, number>();
    for (const row of rows) {
      matchedMessageCounts.set(row.chatId, Number(row.matchedMessageCount));
      const snippets = snippetsByChat.get(row.chatId) ?? [];
      snippets.push({
        messageOrdinal: Number(row.messageOrdinal),
        role: row.role,
        timestamp: row.timestamp,
        text: snippetTextByRow.get(Number(row.rowId)) ?? '',
      });
      snippetsByChat.set(row.chatId, snippets);
    }
    return chatRows.map((row) => ({
      chatId: row.chatId,
      score: -Number(row.rank || 0),
      matchedMessageCount: matchedMessageCounts.get(row.chatId) ?? 0,
      snippets: snippetsByChat.get(row.chatId) ?? [],
    }));
  }

  #upsertState(chatId: string, sourceKey: string, indexedAt: string): void {
    this.#requireDb().query(`
      INSERT INTO chat_search_state (chat_id, source_key, indexed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        source_key = excluded.source_key,
        indexed_at = excluded.indexed_at
    `).run(chatId, sourceKey, indexedAt);
  }

  #stateSourceKey(chatId: string): string | null {
    return this.#requireDb().query<{ sourceKey: string }, [string]>(`
      SELECT source_key AS sourceKey
      FROM chat_search_state
      WHERE chat_id = ?
    `).get(chatId)?.sourceKey ?? null;
  }

  #deleteState(chatId: string): void {
    this.#requireDb().query('DELETE FROM chat_search_state WHERE chat_id = ?').run(chatId);
  }

  #withAllowedChats<T>(chatIds: string[], fn: () => T): T {
    const db = this.#requireDb();
    db.exec('CREATE TEMP TABLE IF NOT EXISTS temp_search_allowed (chat_id TEXT PRIMARY KEY) WITHOUT ROWID');
    db.query('DELETE FROM temp_search_allowed').run();
    const insert = db.query('INSERT OR IGNORE INTO temp_search_allowed (chat_id) VALUES (?)');
    for (const chatId of chatIds) insert.run(chatId);
    return fn();
  }

  #indexStatusForAllowed(allowedCount: number): ChatSearchIndexStatus {
    const indexedChatCount = this.#requireDb().query<{ count: number }, []>(`
      SELECT COUNT(*) AS count
      FROM chat_search_state
      JOIN temp_search_allowed ON temp_search_allowed.chat_id = chat_search_state.chat_id
    `).get()?.count ?? 0;
    return {
      indexedChatCount,
      pendingChatCount: Math.max(0, allowedCount - indexedChatCount),
    };
  }

  #pruneMissingChats(): void {
    const validIds = new Set(Object.keys(this.#deps.registry.listAllChats()));
    const db = this.#requireDb();
    const indexedIds = db.query<{ chatId: string }, []>(`
      SELECT chat_id AS chatId FROM chat_search_state
      UNION
      SELECT chat_id AS chatId FROM chat_search_chunks
    `).all().map((row) => row.chatId);
    const trackedIds = new Set([
      ...indexedIds,
      ...this.#appendRevisions.keys(),
      ...this.#activeReindexes.keys(),
      ...this.#reindexTimers.keys(),
    ]);
    for (const chatId of trackedIds) {
      if (validIds.has(chatId)) continue;
      this.deleteChat(chatId);
    }
  }

  async #sourceKeyForSession(session: ChatRegistryEntry): Promise<string> {
    if (session.nativePath && !isArtificialNativePath(session.nativePath)) {
      try {
        const stat = await fs.stat(session.nativePath);
        return `file:${session.nativePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      } catch {
        return `missing:${session.nativePath}`;
      }
    }
    return `session:${session.agentId}:${session.agentSessionId ?? ''}:${session.nativePath ?? ''}`;
  }

  #nowIso(): string {
    return (this.#deps.now?.() ?? new Date()).toISOString();
  }
}

function messagesToChunks(messages: ChatMessage[]): IndexedMessageChunk[] {
  const chunks: IndexedMessageChunk[] = [];
  messages.forEach((message, index) => {
    const body = normalizeSearchBody(textForMessage(message));
    if (!body) return;
    chunks.push({
      messageOrdinal: index + 1,
      role: roleForMessage(message),
      timestamp: timestampForMessage(message),
      body,
    });
  });
  return chunks;
}

function textForMessage(message: ChatMessage): string {
  switch (message.type) {
    case 'user-message':
    case 'assistant-message':
    case 'thinking':
    case 'error':
      return message.content;
    case 'compaction':
      return message.summary;
    case 'agent-switch':
      return joinText(message.fromAgentId, message.toAgentId, message.fromModel, message.toModel);
    case 'tool-result':
      return extractTextFromUnknown(message.content);
    case 'permission-request':
      return textForMessage(message.requestedTool);
    case 'bash-tool-use':
      return joinText(message.description, message.command);
    case 'exec-tool-use':
      return joinText(message.language, message.code);
    case 'wait-tool-use':
      return joinText(
        message.executionId,
        message.yieldTimeMs === undefined ? undefined : String(message.yieldTimeMs),
        message.maxTokens === undefined ? undefined : String(message.maxTokens),
        message.terminate === undefined ? undefined : String(message.terminate),
      );
    case 'read-tool-use':
    case 'write-tool-use':
      return joinText(message.filePath, 'content' in message ? message.content : undefined);
    case 'list-tool-use':
      return joinText(message.path);
    case 'edit-tool-use':
    case 'apply-patch-tool-use':
      return joinText(message.filePath, message.oldString, message.newString, 'patch' in message ? message.patch : undefined);
    case 'grep-tool-use':
    case 'glob-tool-use':
      return joinText(message.pattern, message.path);
    case 'web-search-tool-use':
    case 'amp-finder-tool-use':
    case 'amp-librarian-tool-use':
    case 'amp-find-thread-tool-use':
      return joinText(message.query, 'context' in message ? message.context : undefined);
    case 'web-fetch-tool-use':
      return joinText(message.url, message.prompt);
    case 'todo-write-tool-use':
    case 'update-plan-tool-use':
      return joinText(...(message.todos ?? []).map((todo) => `${todo.status} ${todo.content}`));
    case 'task-tool-use':
      return joinText(message.subagentType, message.description, message.prompt, message.model);
    case 'codex-subagent-tool-use':
      return joinText(message.action, extractTextFromUnknown(message.details));
    case 'write-stdin-tool-use':
      return extractTextFromUnknown(message.input);
    case 'exit-plan-mode-tool-use':
      return joinText(message.plan, ...(message.allowedPrompts ?? []).map((entry) => `${entry.tool} ${entry.prompt}`));
    case 'ask-user-question-tool-use':
      return joinText(
        message.title,
        ...message.questions.flatMap((question) => [
          question.prompt,
          ...question.options.map((option) => `${option.label} ${option.description ?? ''} ${option.preview ?? ''}`),
        ]),
      );
    case 'cursor-ask-question-tool-use':
      return joinText(
        message.title,
        ...message.questions.flatMap((question) => [
          question.prompt,
          ...question.options.map((option) => `${option.label} ${option.id}`),
        ]),
      );
    case 'cursor-create-plan-tool-use':
      return joinText(
        message.name,
        message.overview,
        message.plan,
        ...(message.todos ?? []).map((todo) => `${todo.status} ${todo.content}`),
        ...(message.phases ?? []).flatMap((phase) => [
          phase.name,
          ...phase.todos.map((todo) => `${todo.status} ${todo.content}`),
        ]),
      );
    case 'amp-oracle-tool-use':
      return joinText(message.task, message.context, ...(message.files ?? []));
    case 'amp-skill-tool-use':
      return joinText(message.name);
    case 'amp-handoff-tool-use':
      return joinText(message.goal);
    case 'amp-look-at-tool-use':
      return joinText(message.path, message.objective);
    case 'amp-read-thread-tool-use':
      return joinText(message.threadId, message.goal);
    case 'amp-task-list-tool-use':
      return joinText(message.action, message.taskId, message.title, message.status);
    case 'external-tool-use':
      return joinText(message.namespace ?? undefined, message.name, extractTextFromUnknown(message.input));
    case 'mcp-tool-use':
      return joinText(message.server, message.tool, extractTextFromUnknown(message.input));
    case 'request-permissions-tool-use':
      return joinText(message.reason, extractTextFromUnknown(message.permissions));
    case 'unknown-tool-use':
      return joinText(message.rawName, extractTextFromUnknown(message.input));
    case 'todo-read-tool-use':
    case 'enter-plan-mode-tool-use':
    case 'amp-mermaid-tool-use':
    case 'permission-resolved':
    case 'permission-cancelled':
      return '';
  }
}

function roleForMessage(message: ChatMessage): ChatSearchSnippetRole {
  if (message.type === 'user-message') return 'user';
  if (message.type === 'assistant-message' || message.type === 'thinking') return 'assistant';
  if (message.type.endsWith('-tool-use') || message.type === 'tool-result' || message.type === 'permission-request') {
    return 'tool';
  }
  return 'system';
}

function timestampForMessage(message: ChatMessage): string | null {
  return 'timestamp' in message && typeof message.timestamp === 'string' ? message.timestamp : null;
}

function normalizeSearchBody(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS);
}

function joinText(...values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ');
}

function extractTextFromUnknown(value: unknown, remaining = MAX_EXTRACTED_VALUE_CHARS): string {
  if (remaining <= 0 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value.slice(0, remaining);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    let left = remaining;
    for (const item of value) {
      const text = extractTextFromUnknown(item, left);
      if (!text) continue;
      parts.push(text);
      left -= text.length;
      if (left <= 0) break;
    }
    return parts.join(' ');
  }
  if (typeof value === 'object') {
    const parts: string[] = [];
    let left = remaining;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const text = extractTextFromUnknown(item, left);
      if (!text) continue;
      const part = `${key} ${text}`;
      parts.push(part);
      left -= part.length;
      if (left <= 0) break;
    }
    return parts.join(' ');
  }
  return '';
}

function buildFtsQuery(tokens: string[]): string | null {
  const terms = tokens.flatMap((token) => {
    const words = token.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (words.length === 0) return [];
    if (words.length === 1) return `${words[0]}*`;
    return words.map((word) => `${word}*`).join(' AND ');
  });
  return terms.length > 0 ? terms.join(' AND ') : null;
}

function buildSnippetFtsQuery(tokens: string[]): string {
  const words = tokens.flatMap((token) => token.match(/[\p{L}\p{N}_]+/gu) ?? []);
  return Array.from(new Set(words)).map((word) => `${word}*`).join(' OR ');
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit)) return DEFAULT_RESULT_LIMIT;
  return Math.min(MAX_RESULT_LIMIT, Math.max(1, Number(limit)));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeSnippet(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
