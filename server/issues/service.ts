import { parseHttpIssueMutationRequest, parseIssueMutationPayload, type HttpIssueMutationRequest,
  type IssueMutationPayload } from '../../common/issue-commands.js';
import { parseIssueCommentsQuery, parseIssueHistoryQuery, parseIssueListQuery, parseIssueReadQuery } from '../../common/issue-query.js';
import { issueInteger, issueRecord, issueString } from '../../common/issue-validation.js';
import type { IssueBootstrap, IssueOwner, IssueWriteResult } from '../../common/issues.js';
import { createLogger } from '../lib/log.js';
import { issueAuthorityKey, issueFingerprint, type IssueAuthority, type IssueCaller, type IssueMutationContext } from './contracts.js';
import { IssueDomainError, nextIssueCounter, validateIssueInput } from './errors.js';
import { mutateIssue } from './mutations.js';
import { countIssues, HTTP_ISSUE_BUDGET, issueFacets, listIssues, readIssueComments,
  readIssueDetail, readIssueHistory, type IssueReadBudget } from './queries.js';
import { collectionRevision, readOperation } from './records.js';
import { IssueStore } from './store.js';

const logger = createLogger('issues');

export interface IssueServiceOptions {
  readonly chatExists: (chatId: string) => boolean;
  readonly commandsEnabled: () => boolean;
  readonly onInvalidated?: (revision: number) => void;
  readonly now?: () => string;
}

export class IssueService {
  constructor(private readonly store: IssueStore, private readonly options: IssueServiceOptions) {}

  get storeId(): string { return this.store.storeId; }

  bootstrap(authority: IssueAuthority): IssueBootstrap {
    return this.store.read((database) => ({ storeId: this.storeId, collectionRevision: collectionRevision(database),
      viewerKey: issueAuthorityKey(authority) }));
  }

  lookupOperation(context: IssueMutationContext): IssueWriteResult | null {
    this.#admit(context);
    return this.store.read((database) => readOperation(database, context));
  }

  executeHttp(value: HttpIssueMutationRequest, caller: IssueCaller, signal?: AbortSignal): IssueWriteResult {
    const request = validateIssueInput(() => parseHttpIssueMutationRequest(value));
    if (caller.actor.kind !== 'user' || caller.actor.declaredChatId !== (request.fromChatId ?? null)) {
      throw new IssueDomainError('ISSUE_UNAUTHORIZED', 'Issue caller does not match the authenticated request.');
    }
    const context: IssueMutationContext = { ...caller, expectedStoreId: request.expectedStoreId, source: null,
      operationKey: JSON.stringify(['http', issueAuthorityKey(caller.authority), request.requestId]),
      fingerprint: issueFingerprint(request.payload, caller.actor) };
    signal?.throwIfAborted();
    return this.execute(request.payload, context);
  }

  execute(value: IssueMutationPayload, context: IssueMutationContext): IssueWriteResult {
    const payload = validateIssueInput(() => parseIssueMutationPayload(value));
    this.#admit(context);
    const committed = this.store.transaction((database) => {
      this.#admit(context);
      const previous = readOperation(database, context);
      if (previous) return { result: previous, changed: false };
      this.#requireReferences(payload, context);
      const now = this.options.now?.() ?? new Date().toISOString();
      const change = mutateIssue(database, payload, context, now);
      let revision = collectionRevision(database);
      if (change.changed) {
        revision = nextIssueCounter(revision);
        database.query('UPDATE issue_meta SET revision=? WHERE singleton=1').run(revision);
      }
      const result: IssueWriteResult = { success: true, storeId: this.storeId, collectionRevision: revision,
        issue: change.issue, ...(change.comment ? { comment: change.comment } : {}),
        ...(change.relatedIssue ? { relatedIssue: change.relatedIssue } : {}) };
      database.query('INSERT INTO issue_operations VALUES (?,?,?)')
        .run(context.operationKey, context.fingerprint, JSON.stringify(result));
      return { result, changed: change.changed };
    });
    if (committed.changed) {
      try { this.options.onInvalidated?.(committed.result.collectionRevision); }
      catch { logger.warn('Issue invalidation listener failed after commit.'); }
    }
    return committed.result;
  }

  list(value: unknown, budget: IssueReadBudget = HTTP_ISSUE_BUDGET) {
    const query = validateIssueInput(() => parseIssueListQuery(value));
    return this.store.read((database) => listIssues(database, this.storeId, query, budget));
  }

  counts(value: unknown) {
    const query = validateIssueInput(() => {
      issueRecord(value, ['project', 'status', 'includeClosed', 'priority', 'label', 'assignee', 'ready', 'query', 'expectedCollectionRevision']);
      return parseIssueListQuery(value);
    });
    return this.store.read((database) => countIssues(database, this.storeId, query));
  }

  read(value: unknown, authority: IssueAuthority, budget: IssueReadBudget = HTTP_ISSUE_BUDGET) {
    const query = validateIssueInput(() => parseIssueReadQuery(value));
    return this.store.read((database) => readIssueDetail(database, this.storeId, query, authority, budget));
  }

  comments(value: unknown, authority: IssueAuthority, budget: IssueReadBudget = HTTP_ISSUE_BUDGET) {
    const query = validateIssueInput(() => parseIssueCommentsQuery(value));
    return this.store.read((database) => readIssueComments(database, this.storeId, query, authority, budget));
  }

  history(value: unknown, budget: IssueReadBudget = HTTP_ISSUE_BUDGET) {
    const query = validateIssueInput(() => parseIssueHistoryQuery(value));
    return this.store.read((database) => readIssueHistory(database, this.storeId, query, budget));
  }

  facets(field: 'project' | 'label', prefix: string) {
    validateIssueInput(() => {
      if (field !== 'project' && field !== 'label') throw new IssueDomainError('ISSUE_VALIDATION_FAILED', 'Unknown issue facet.');
      issueString(prefix, 'prefix');
      issueInteger(Array.from(prefix).length, 'prefix length', 0, 4096);
    });
    return this.store.read((database) => issueFacets(database, this.storeId, field, prefix));
  }

  close(): void { this.store.close(); }

  #admit(context: IssueMutationContext): void {
    if (context.expectedStoreId !== this.storeId) {
      throw new IssueDomainError('ISSUE_STORE_CHANGED', 'Issue storage changed. Preserve the draft and refresh before creating a new request.');
    }
    if ((context.actor.kind === 'chat' || context.actor.declaredChatId !== null) && !this.options.commandsEnabled()) {
      throw new IssueDomainError('ISSUE_COMMANDS_DISABLED', 'Agent issue commands are disabled.');
    }
  }

  #requireReferences(payload: IssueMutationPayload, context: IssueMutationContext): void {
    if (context.actor.kind === 'user' && context.actor.declaredChatId) this.#requireChat(context.actor.declaredChatId);
    if (context.actor.kind === 'chat') this.#requireChat(context.actor.chatId);
    if (payload.action === 'claim' || payload.action === 'release') this.#requireOwner(context.owner, context);
    if (payload.action === 'create' && payload.input.assignee) this.#requireOwner(payload.input.assignee, context);
    if (payload.action === 'update' && payload.patch.assignee) this.#requireOwner(payload.patch.assignee, context);
  }

  #requireOwner(owner: IssueOwner, context: IssueMutationContext): void {
    if (owner.kind === 'chat') return this.#requireChat(owner.chatId);
    if (context.actor.kind !== 'user' || owner.username !== context.actor.username) {
      throw new IssueDomainError('ISSUE_VALIDATION_FAILED', 'A user assignment must name the current authenticated user.');
    }
  }

  #requireChat(chatId: string): void {
    if (!this.options.chatExists(chatId)) throw new IssueDomainError('ISSUE_CHAT_NOT_FOUND', 'The assigned or declared chat no longer exists.');
  }
}
