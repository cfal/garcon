import crypto from 'node:crypto';
import type {
  AgentPermissionLifecycle,
  AgentProducerEvent,
  AgentProducerSink,
  AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import type { AgentAttachment } from '../../common/agent-execution.js';
import type { ChatMessage, UserMessage } from '../../common/chat-types.js';
import type { ChatTransientControlAction } from '../../common/chat-transient-feed.js';
import type { ResendCandidate } from '../../common/chat-view.js';
import type {
  InputComposition,
  LedgerNoticeRow,
  LedgerPermissionRow,
  LedgerRow,
  LedgerRowDraft,
  LedgerRunEndedRow,
  LedgerSessionRow,
  LedgerUserInputRow,
  TranscriptPage,
  TranscriptNativeActivityState,
  TranscriptView,
  TranscriptViewId,
  TranscriptWatermark,
} from './contracts.js';
import { transcriptViewId } from './contracts.js';
import { PermissionNotActionableError } from './errors.js';
import { TranscriptLedgerStore } from './store.js';

export class TranscriptSinkClosedError extends Error {
  constructor() {
    super('Transcript producer sink is closed');
    this.name = 'TranscriptSinkClosedError';
  }
}

export interface TranscriptProducerLease {
  readonly sink: AgentProducerSink;
  close(): void;
  readonly closed: boolean;
}

export type TranscriptCommitEvent =
  | {
      readonly type: 'rows';
      readonly chatId: string;
      readonly viewId: TranscriptViewId;
      readonly rows: readonly LedgerRow[];
    }
  | {
      readonly type: 'session';
      readonly chatId: string;
      readonly viewId: TranscriptViewId;
      readonly row: LedgerSessionRow;
    }
  | {
      readonly type: 'permission';
      readonly chatId: string;
      readonly viewId: TranscriptViewId;
      readonly runId: string | null;
      readonly row: LedgerPermissionRow;
    }
  | {
      readonly type: 'run-ended';
      readonly chatId: string;
      readonly viewId: TranscriptViewId;
      readonly runId: string;
      readonly row: LedgerRunEndedRow;
    }
  | {
      readonly type: 'view-replaced';
      readonly chatId: string;
      readonly previousViewId: TranscriptViewId;
      readonly view: TranscriptView;
    };

export type TranscriptSessionCommitEvent = Extract<TranscriptCommitEvent, { readonly type: 'session' }>;

export interface TranscriptLedgerServiceOptions {
  readonly now?: () => string;
  readonly createRunId?: () => string;
  readonly serverInstanceId?: string;
  readonly onListenerError?: (error: unknown) => void;
}

export interface PermissionResolutionClaim {
  readonly chatId: string;
  readonly viewId: TranscriptViewId;
  readonly runId: string;
  readonly requestId: string;
  readonly incarnation: string;
  readonly claimId: string;
}

interface ActivePermission {
  readonly runId: string;
  readonly incarnation: string;
  readonly claimId: string | null;
}

export class TranscriptLedgerService {
  readonly #store: TranscriptLedgerStore;
  readonly #now: () => string;
  readonly #createRunId: () => string;
  readonly #serverInstanceId: string;
  readonly #onListenerError: (error: unknown) => void;
  readonly #listeners = new Set<(event: TranscriptCommitEvent) => void | Promise<void>>();
  readonly #sessionCommitListeners = new Set<(event: TranscriptSessionCommitEvent) => void>();
  readonly #leases = new Map<string, ProducerLease>();
  readonly #activeRuns = new Map<string, string>();
  readonly #activePermissions = new Map<string, Map<string, ActivePermission>>();
  readonly #permissionClaims = new Map<string, PermissionResolutionClaim>();
  readonly #preparedInputs = new Map<string, InputComposition>();

  constructor(store: TranscriptLedgerStore, options: TranscriptLedgerServiceOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createRunId = options.createRunId ?? (() => crypto.randomUUID());
    this.#serverInstanceId = options.serverInstanceId ?? crypto.randomUUID();
    this.#onListenerError = options.onListenerError ?? (() => undefined);
  }

  subscribe(listener: (event: TranscriptCommitEvent) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeSessionCommitted(listener: (event: TranscriptSessionCommitEvent) => void): () => void {
    this.#sessionCommitListeners.add(listener);
    return () => this.#sessionCommitListeners.delete(listener);
  }

  initializeChat(
    chatId: string,
    rows: readonly LedgerRowDraft[] = [],
    contentStartOrdinal = 1,
  ): TranscriptView {
    return this.#store.initializeCurrentView(chatId, { rows, contentStartOrdinal });
  }

  currentView(chatId: string): TranscriptView | null {
    return this.#store.currentView(chatId);
  }

  openProducer(chatId: string, ownerAgentId: string): TranscriptProducerLease {
    if (!ownerAgentId) throw new TypeError('Producer owner agent ID is required');
    const view = this.#store.currentView(chatId);
    if (!view) throw new TypeError(`Transcript view is not initialized for ${chatId}`);
    const existing = this.#leases.get(chatId);
    if (existing && !existing.closed) {
      throw new TypeError(`Transcript producer sink is already open for ${chatId}`);
    }
    const lease = new ProducerLease((event) => {
      if (this.#leases.get(chatId) !== lease) throw new TranscriptSinkClosedError();
      this.#publish(chatId, view.viewId, ownerAgentId, event);
    }, () => {
      if (this.#leases.get(chatId) === lease) this.#leases.delete(chatId);
      this.#activeRuns.delete(chatId);
      this.#activePermissions.delete(chatId);
      this.#deletePermissionClaims(chatId);
    });
    this.#leases.set(chatId, lease);
    return lease;
  }

  closeProducer(chatId: string): void {
    this.#leases.get(chatId)?.close();
  }

  beginRun(chatId: string, runId = this.#createRunId()): string {
    if (!runId) throw new TypeError('Run ID is required');
    if (!this.#leases.has(chatId)) throw new TranscriptSinkClosedError();
    if (this.#activeRuns.has(chatId)) {
      throw new TypeError(`Transcript run is already active for ${chatId}`);
    }
    this.#activePermissions.delete(chatId);
    this.#activeRuns.set(chatId, runId);
    return runId;
  }

  handoffRun(chatId: string, expectedRunId: string, nextRunId: string): void {
    if (!nextRunId) throw new TypeError('Run ID is required');
    if (this.#activeRuns.get(chatId) !== expectedRunId) {
      throw new TypeError(`Transcript run changed before handoff for ${chatId}`);
    }
    this.#activePermissions.delete(chatId);
    this.#activeRuns.set(chatId, nextRunId);
  }

  activeRunId(chatId: string): string | null {
    return this.#activeRuns.get(chatId) ?? null;
  }

  isRunActive(chatId: string, runId?: string): boolean {
    const active = this.#activeRuns.get(chatId);
    return active !== undefined && (runId === undefined || active === runId);
  }

  activeChatIds(): readonly string[] {
    return [...this.#activeRuns.keys()];
  }

  interruptRun(chatId: string): LedgerRunEndedRow | null {
    const runId = this.#activeRuns.get(chatId);
    if (!runId) return null;
    this.#activeRuns.delete(chatId);
    return this.#appendRunEnd(chatId, runId, 'interrupted', 'core');
  }

  failRun(
    chatId: string,
    runId: string,
    error?: AgentRunFailureDetail,
  ): LedgerRunEndedRow | null {
    if (this.#activeRuns.get(chatId) !== runId) return null;
    this.#activeRuns.delete(chatId);
    return this.#appendRunEnd(chatId, runId, 'failed', 'core', error);
  }

  appendInputAndCompose(input: {
    readonly chatId: string;
    readonly viewId: TranscriptViewId;
    readonly message: UserMessage;
    readonly attachments: readonly AgentAttachment[];
    readonly clientMessageId: string | null;
    readonly steer: boolean;
    readonly excludedOrdinals?: ReadonlySet<number>;
  }): InputComposition {
    const composition = this.#store.appendInputAndCompose(input.chatId, {
      viewId: input.viewId,
      at: input.message.timestamp,
      detail: {
        clientMessageId: input.clientMessageId,
        message: input.message,
        attachments: input.attachments,
        steer: input.steer,
      },
      excludedOrdinals: input.excludedOrdinals,
    });
    if (composition.inserted) {
      this.#notify({
        type: 'rows',
        chatId: input.chatId,
        viewId: input.viewId,
        rows: [composition.input],
      });
    }
    if (input.clientMessageId) {
      this.#preparedInputs.set(inputKey(input.chatId, input.clientMessageId), composition);
    }
    return composition;
  }

  takePreparedInput(chatId: string, clientMessageId: string | null | undefined): InputComposition | null {
    if (!clientMessageId) return null;
    const key = inputKey(chatId, clientMessageId);
    const composition = this.#preparedInputs.get(key) ?? null;
    this.#preparedInputs.delete(key);
    return composition;
  }

  claimPermissionResolution(action: ChatTransientControlAction): PermissionResolutionClaim {
    if (action.serverInstanceId !== this.#serverInstanceId) throw new PermissionNotActionableError();
    const runId = action.runId;
    const permission = this.#activePermissions.get(action.chatId)?.get(action.id);
    if (
      !permission
      || permission.runId !== runId
      || permission.incarnation !== action.incarnation
      || permission.claimId !== null
      || this.#activeRuns.get(action.chatId) !== runId
    ) {
      throw new PermissionNotActionableError();
    }
    const view = this.#store.currentView(action.chatId);
    if (!view) throw new PermissionNotActionableError();
    const claim = Object.freeze({
      chatId: action.chatId,
      viewId: view.viewId,
      runId,
      requestId: action.id,
      incarnation: action.incarnation,
      claimId: crypto.randomUUID(),
    });
    this.#activePermissions.get(action.chatId)!.set(action.id, {
      ...permission,
      claimId: claim.claimId,
    });
    this.#permissionClaims.set(claim.claimId, claim);
    return claim;
  }

  completePermissionResolution(
    claim: PermissionResolutionClaim,
    decision: Extract<AgentPermissionLifecycle, { readonly kind: 'resolved' }>['decision'],
  ): LedgerPermissionRow {
    if (this.#permissionClaims.get(claim.claimId) !== claim) {
      throw new PermissionNotActionableError();
    }
    this.#permissionClaims.delete(claim.claimId);
    const [row] = this.#store.append(claim.chatId, claim.viewId, [{
      kind: 'permission-resolved',
      at: this.#now(),
      lifecycle: {
        kind: 'resolved',
        requestId: claim.requestId,
        incarnation: claim.incarnation,
        decision,
      },
      providerMeta: null,
    }]);
    const permission = row as LedgerPermissionRow;
    const active = this.#activePermissions.get(claim.chatId)?.get(claim.requestId);
    if (active?.claimId === claim.claimId) {
      this.#activePermissions.get(claim.chatId)?.delete(claim.requestId);
    }
    this.#notify({
      type: 'permission',
      chatId: claim.chatId,
      viewId: claim.viewId,
      runId: null,
      row: permission,
    });
    return permission;
  }

  abandonPermissionResolution(claim: PermissionResolutionClaim): void {
    if (this.#permissionClaims.get(claim.claimId) !== claim) return;
    this.#permissionClaims.delete(claim.claimId);
    const permissions = this.#activePermissions.get(claim.chatId);
    const active = permissions?.get(claim.requestId);
    if (
      active?.claimId === claim.claimId
      && this.#activeRuns.get(claim.chatId) === claim.runId
    ) {
      permissions!.set(claim.requestId, { ...active, claimId: null });
    }
  }

  appendNotice(input: {
    readonly chatId: string;
    readonly viewId: TranscriptViewId;
    readonly message: string;
    readonly detail: LedgerNoticeRow['detail'];
  }): LedgerNoticeRow {
    const [row] = this.#store.append(input.chatId, input.viewId, [{
      kind: 'notice',
      at: this.#now(),
      message: input.message,
      detail: input.detail,
      providerMeta: null,
    }]);
    this.#notify({
      type: 'rows',
      chatId: input.chatId,
      viewId: input.viewId,
      rows: [row!],
    });
    return row as LedgerNoticeRow;
  }

  page(chatId: string, viewId: TranscriptViewId, limit: number, before?: number): TranscriptPage {
    return this.#store.page(chatId, viewId, limit, before);
  }

  rowsAfter(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
  ): readonly LedgerRow[] {
    return this.#store.rowsAfter(chatId, viewId, afterOrdinal);
  }

  currentRows(chatId: string): readonly LedgerRow[] {
    return this.#store.currentRows(chatId);
  }

  rowsThrough(chatId: string, watermark: TranscriptWatermark): readonly LedgerRow[] {
    return this.#store.rowsThrough(chatId, watermark);
  }

  assistantMessagesForSubmission(
    chatId: string,
    viewId: TranscriptViewId,
    clientMessageId: string,
    throughOrdinal: number,
  ): readonly string[] {
    return this.#store.assistantMessagesForSubmission(
      chatId,
      viewId,
      clientMessageId,
      throughOrdinal,
    );
  }

  conversationRows(chatId: string): readonly (LedgerUserInputRow | Extract<LedgerRow, { kind: 'provider-row' }>)[] {
    return this.#store.currentRows(chatId).filter(isConversationRow);
  }

  conversationMessages(chatId: string, excludedOrdinals: ReadonlySet<number> = new Set()): readonly ChatMessage[] {
    return this.conversationRows(chatId)
      .filter((row) => !excludedOrdinals.has(row.ordinal))
      .map(messageForConversationRow);
  }

  resendCandidates(chatId: string): readonly ResendCandidate[] {
    return this.#store.resendCandidates(chatId).map((row) => ({
      ordinal: row.ordinal,
      content: row.detail.message.content,
      attachmentNames: row.detail.attachments.map((attachment) => attachment.name ?? 'attachment'),
    }));
  }

  currentSession(chatId: string): LedgerSessionRow | null {
    return this.#store.currentSession(chatId);
  }

  nativeActivityState(chatId: string): TranscriptNativeActivityState {
    return this.#store.nativeActivityState(chatId);
  }

  highWatermark(chatId: string): TranscriptWatermark {
    return this.#store.highWatermark(chatId);
  }

  checkpointForHandoff(chatId: string): TranscriptWatermark {
    const checkpoint = this.#store.checkpointForHandoff(chatId);
    return { viewId: checkpoint.viewId, ordinal: checkpoint.ordinal };
  }

  advanceContentStart(
    chatId: string,
    viewId: TranscriptViewId,
    contentStartOrdinal: number,
  ): TranscriptView {
    return this.#store.advanceContentStart(chatId, viewId, contentStartOrdinal);
  }

  replaceCurrentView(
    chatId: string,
    expectedViewId: TranscriptViewId,
    stagingViewId: TranscriptViewId,
  ): TranscriptView {
    this.closeProducer(chatId);
    const view = this.#store.replaceCurrentView(chatId, expectedViewId, stagingViewId);
    this.#activePermissions.delete(chatId);
    this.#deletePermissionClaims(chatId);
    this.#deletePreparedInputs(chatId);
    this.#notify({
      type: 'view-replaced',
      chatId,
      previousViewId: expectedViewId,
      view,
    });
    return view;
  }

  stageView(
    chatId: string,
    rows: readonly LedgerRowDraft[],
    contentStartOrdinal: number,
    viewId = transcriptViewId(crypto.randomUUID()),
  ): TranscriptView {
    return this.#store.stageView(chatId, { viewId, rows, contentStartOrdinal });
  }

  discardStagingView(chatId: string, viewId: TranscriptViewId): void {
    this.#store.discardStagingView(chatId, viewId);
  }

  closeChat(chatId: string): void {
    this.#clearChatState(chatId);
    this.#store.closeChat(chatId);
  }

  deleteChat(chatId: string): void {
    this.#clearChatState(chatId);
    this.#store.deleteChat(chatId);
  }

  close(): void {
    for (const lease of this.#leases.values()) lease.close();
    this.#leases.clear();
    this.#activeRuns.clear();
    this.#activePermissions.clear();
    this.#permissionClaims.clear();
    this.#preparedInputs.clear();
    this.#sessionCommitListeners.clear();
    this.#store.close();
  }

  #deletePreparedInputs(chatId: string): void {
    const prefix = `${chatId}\u0000`;
    for (const key of this.#preparedInputs.keys()) {
      if (key.startsWith(prefix)) this.#preparedInputs.delete(key);
    }
  }

  #clearChatState(chatId: string): void {
    this.closeProducer(chatId);
    this.#activeRuns.delete(chatId);
    this.#activePermissions.delete(chatId);
    this.#deletePermissionClaims(chatId);
    this.#deletePreparedInputs(chatId);
  }

  #publish(
    chatId: string,
    viewId: TranscriptViewId,
    ownerAgentId: string,
    event: AgentProducerEvent,
  ): void {
    switch (event.type) {
      case 'rows': {
        if (event.rows.length === 0) return;
        const rows = this.#store.append(chatId, viewId, event.rows.map((row) => ({
          kind: 'provider-row' as const,
          at: row.message.timestamp,
          message: row.message,
          providerMeta: row.providerMeta ?? null,
        })));
        this.#notify({ type: 'rows', chatId, viewId, rows });
        return;
      }
      case 'session': {
        if (event.session.nativeSession?.ownerId !== undefined
            && event.session.nativeSession.ownerId !== ownerAgentId) {
          throw new TypeError(`Native session owner mismatch for ${chatId}`);
        }
        const [row] = this.#store.append(chatId, viewId, [{
          kind: 'session',
          at: this.#now(),
          detail: event.session,
          providerMeta: null,
        }]);
        const committed = { type: 'session', chatId, viewId, row: row as LedgerSessionRow } as const;
        for (const listener of this.#sessionCommitListeners) {
          try {
            listener(committed);
          } catch (error) {
            this.#onListenerError(error);
          }
        }
        this.#notify(committed);
        return;
      }
      case 'permission': {
        const [row] = this.#store.append(chatId, viewId, [{
          kind: permissionRowKind(event.lifecycle),
          at: this.#now(),
          lifecycle: event.lifecycle,
          providerMeta: null,
        }]);
        this.#notify({
          type: 'permission',
          chatId,
          viewId,
          runId: event.runId,
          row: row as LedgerPermissionRow,
        });
        this.#applyPermissionLifecycle(chatId, event.runId, event.lifecycle);
        return;
      }
      case 'run-ended': {
        if (this.#activeRuns.get(chatId) !== event.runId) return;
        this.#activeRuns.delete(chatId);
        this.#appendRunEnd(
          chatId,
          event.runId,
          event.outcome,
          'provider',
          event.error,
        );
      }
    }
  }

  #appendRunEnd(
    chatId: string,
    runId: string,
    outcome: LedgerRunEndedRow['outcome'],
    origin: LedgerRunEndedRow['origin'],
    error?: AgentRunFailureDetail,
  ): LedgerRunEndedRow {
    const view = this.#store.currentView(chatId);
    if (!view) throw new TypeError(`Transcript view is not initialized for ${chatId}`);
    const [row] = this.#store.append(chatId, view.viewId, [{
      kind: 'run-ended',
      at: this.#now(),
      outcome,
      origin,
      ...(error ? { error } : {}),
      providerMeta: null,
    }]);
    const ended = row as LedgerRunEndedRow;
    this.#clearRunPermissions(chatId, runId);
    this.#notify({ type: 'run-ended', chatId, viewId: view.viewId, runId, row: ended });
    return ended;
  }

  #applyPermissionLifecycle(
    chatId: string,
    runId: string,
    lifecycle: Exclude<AgentPermissionLifecycle, { readonly kind: 'resolved' }>,
  ): void {
    if (lifecycle.kind === 'requested') {
      if (this.#activeRuns.get(chatId) !== runId) return;
      let permissions = this.#activePermissions.get(chatId);
      if (!permissions) {
        permissions = new Map();
        this.#activePermissions.set(chatId, permissions);
      }
      permissions.set(lifecycle.requestId, {
        runId,
        incarnation: lifecycle.incarnation,
        claimId: null,
      });
      return;
    }
    const permissions = this.#activePermissions.get(chatId);
    const active = permissions?.get(lifecycle.requestId);
    if (active?.runId === runId && active.incarnation === lifecycle.incarnation) {
      permissions!.delete(lifecycle.requestId);
    }
  }

  #clearRunPermissions(chatId: string, runId: string): void {
    const permissions = this.#activePermissions.get(chatId);
    if (!permissions) return;
    for (const [requestId, permission] of permissions) {
      if (permission.runId === runId) permissions.delete(requestId);
    }
    if (permissions.size === 0) this.#activePermissions.delete(chatId);
  }

  #deletePermissionClaims(chatId: string): void {
    for (const [claimId, claim] of this.#permissionClaims) {
      if (claim.chatId === chatId) this.#permissionClaims.delete(claimId);
    }
  }

  #notify(event: TranscriptCommitEvent): void {
    queueMicrotask(() => {
      for (const listener of this.#listeners) {
        try {
          void Promise.resolve(listener(event)).catch(this.#onListenerError);
        } catch (error) {
          this.#onListenerError(error);
        }
      }
    });
  }
}

function inputKey(chatId: string, clientMessageId: string): string {
  return `${chatId}\u0000${clientMessageId}`;
}

class ProducerLease implements TranscriptProducerLease {
  #closed = false;

  readonly sink: AgentProducerSink;

  constructor(
    publish: (event: AgentProducerEvent) => void,
    private readonly onClose: () => void,
  ) {
    this.sink = Object.freeze({
      publish: (event: AgentProducerEvent) => {
        if (this.#closed) throw new TranscriptSinkClosedError();
        publish(event);
      },
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose();
  }
}

function permissionRowKind(
  lifecycle: Exclude<AgentPermissionLifecycle, { readonly kind: 'resolved' }>,
): LedgerPermissionRow['kind'] {
  return `permission-${lifecycle.kind}`;
}

function isConversationRow(
  row: LedgerRow,
): row is LedgerUserInputRow | Extract<LedgerRow, { kind: 'provider-row' }> {
  return row.kind === 'user-input' || row.kind === 'provider-row';
}

function messageForConversationRow(
  row: LedgerUserInputRow | Extract<LedgerRow, { kind: 'provider-row' }>,
): ChatMessage {
  return row.kind === 'user-input' ? row.detail.message : row.message;
}
