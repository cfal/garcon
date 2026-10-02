import {
  AgentCallError, AgentIntegrationError, isAgentIntegrationErrorCode,
  type AgentIntegrationErrorCode, type AgentDeliveryOutcome, type ExecutorCallOptions,
} from '@garcon/server-agent-interface';
import type { JsonObject } from '@garcon/common/json';
import {
  rpcContinuity,
  SESSION_INSTALLATION_METHODS,
  type ExecutorRpcMethods, type ExecutorRpcRequest, type AgentProducerFrame, type ProducerAckFrame, type ProducerAcknowledgement,
  type OutstandingCall, type OutstandingCallState, type ReplyAckFrame, type RpcContinuity,
} from './rpc-protocol.js';
import type { SessionTransport } from './session-transport.js';
import type { JournaledCall, RpcJournalOwner, RpcReplyJournal } from './rpc-journal.js';
import { DomainError } from '../../common/domain-error.js';
import { ExecutorSessionLostError, reconnectTimedOut } from '../../common/executor-disconnect.js';
import { withActivity } from '../../common/event-loop-stalls.js';
import { createLogger } from '../../common/log.js';
import { failureReason, MALFORMED_DATA } from './failure-reason.js';
import { isErrorCode, type ErrorCode } from '../../../common/error-codes.js';
import { TerminalError } from '../../../common/terminal-error.js';
import { GitServiceError, isGitServiceErrorCode, type GitServiceErrorCode } from '../../../common/git-error.js';
import { parseTerminalStreamServerMessage, type TerminalErrorCode } from '../../../common/terminal.js';
import { parseTerminalNotification, type TerminalNotification } from './terminal-protocol.js';
import { RpcAdmission, type RpcAdmissionBudgets } from './rpc-admission.js';
import { parseBulkControl, type BulkConnectionControl } from './rpc-lane.js';
import { BULK_CONTROL_BYTES, RPC_CALL_LIMIT, RPC_INSTALLATION_CALL_LIMIT } from './limits.js';
import { assertRpcLane, assertRpcReplySize, assertRpcRequestSize } from './rpc-routing.js';

interface Failure {
  readonly code: AgentIntegrationErrorCode | ErrorCode | TerminalErrorCode | GitServiceErrorCode;
  readonly domain?: 'executor' | 'terminal' | 'git';
  readonly status?: number;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
  readonly outcome?: AgentDeliveryOutcome;
}

type ReplyFrame =
  | { readonly type: 'result'; readonly id: string; readonly value: unknown }
  | { readonly type: 'error'; readonly id: string; readonly error: Failure };

type RpcFrame = ExecutorRpcRequest | AgentProducerFrame | ProducerAckFrame | ReplyAckFrame | TerminalNotification | ReplyFrame | BulkConnectionControl
  | { readonly type: 'terminal-detach'; readonly request: ExecutorRpcMethods['terminals.detach']['request'] }
  | { readonly type: 'cancel'; readonly id: string };

export interface RpcCallOptions<Result = unknown> extends Omit<ExecutorCallOptions, 'timeoutMs'> {
  readonly timeoutMs?: number | null;
  readonly onLateResult?: (value: Result) => void | Promise<unknown>;
  // Runs when the session is lost before a cancelled call's late cleanup begins.
  readonly onLateResultLost?: () => void;
}

interface LateResult {
  readonly release: () => void;
  readonly receive: (value: unknown) => void | Promise<unknown>;
  readonly lost: (() => void) | undefined;
}

const log = createLogger('executor-rpc');

export const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const REPLY_ACK_DELAY_MS = 250;
const REPLY_ACK_BATCH = 1024;

type RpcReplyGuard = (bytes: number) => void;
export type GuardRpcReply = (guard: RpcReplyGuard) => void;
// Registers a listener for a reply the session could not take, which the caller
// then receives as an unknown outcome on a live session.
export type ObserveUndeliveredReply = (listener: () => void) => void;
type RpcHandler = (
  request: ExecutorRpcRequest,
  signal: AbortSignal,
  guardReply: GuardRpcReply,
  onUndeliveredReply: ObserveUndeliveredReply,
) => Promise<unknown>;

interface OutgoingCall {
  readonly id: string;
  readonly integrationId: string;
  readonly method: keyof ExecutorRpcMethods;
  readonly request: unknown;
  readonly journaled: boolean;
  // Where the call was last sent, which a reconcile names.
  session: string;
  seq: number;
  // The session holding the call; null while it is parked.
  rpc: ExecutorRpc | null;
  // Once its session is lost, the call waits for a replacement session to
  // reconcile it only until then.
  readonly dispatchDeadline: number | undefined;
  // Armed from parking until a replacement session has reconciled the call.
  expiry: ReturnType<typeof setTimeout> | null;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  cleanup: () => void;
  // Settles the call with an unknown outcome.
  expire: () => void;
}

function disarmExpiry(call: OutgoingCall): void {
  if (call.expiry) clearTimeout(call.expiry);
  call.expiry = null;
}

interface IncomingCall {
  readonly controller: AbortController;
  readonly continuity: RpcContinuity;
}

// Journaled calls whose session was lost, which a controller keeps until a
// replacement session of the same worker reconciles them. Their deadlines and
// signals keep running meanwhile, and a call's dispatch deadline ends its wait
// for the replacement, including the reconciliation, with an unknown outcome.
export class ParkedRpcCalls {
  readonly admission = new RpcAdmission();
  readonly #calls = new Map<string, OutgoingCall>();
  #closed = false;

  get size(): number { return this.#calls.size; }

  park(call: OutgoingCall): void {
    call.rpc = null;
    this.#calls.set(call.id, call);
    if (call.dispatchDeadline !== undefined && !call.expiry) {
      call.expiry = setTimeout(() => call.expire(), Math.max(0, call.dispatchDeadline - performance.now()));
      call.expiry.unref?.();
    }
    if (this.#closed) this.rejectAll();
  }

  release(call: OutgoingCall): boolean {
    disarmExpiry(call);
    return this.#calls.delete(call.id);
  }

  // The calls' expiries stay armed while a replacement session reconciles them.
  take(): OutgoingCall[] {
    const calls = [...this.#calls.values()];
    this.#calls.clear();
    return calls;
  }

  // For a disposed client, whose sessions end after it stops waiting for them.
  close(): void {
    this.#closed = true;
    this.rejectAll();
  }

  // No replacement session of the same worker will ask for these replies.
  rejectAll(): void {
    for (const call of this.take()) {
      call.cleanup();
      call.reject(new AgentCallError('unknown', 'The connection to the executor dropped before it replied.'));
    }
  }
}

export interface ExecutorRpcContinuity {
  // A controller parks journaled calls when their session is lost.
  readonly parked?: ParkedRpcCalls;
  // A worker runs journaled calls beyond their session and keeps their replies.
  readonly journal?: RpcReplyJournal;
  readonly admission?: RpcAdmissionBudgets;
  readonly recovering?: boolean;
}

export class ExecutorRpc {
  readonly #pending = new Map<string, OutgoingCall>();
  readonly #lateResults = new Map<string, LateResult>();
  readonly #incoming = new Map<string, IncomingCall>();
  readonly #parked: ParkedRpcCalls | null;
  readonly #journal: RpcReplyJournal | null;
  readonly #journalOwner: RpcJournalOwner;
  readonly #outgoingAdmission: RpcAdmission;
  readonly #incomingAdmission: RpcAdmission;
  #sent = 0;
  #received = 0;
  #replyAcks: string[] = [];
  #replyAckTimer: ReturnType<typeof setTimeout> | null = null;
  #handler: RpcHandler | null = null;
  #producer: ((frame: AgentProducerFrame) => void) | null = null;
  #producerAck: ((acknowledgements: readonly ProducerAcknowledgement[]) => void) | null = null;
  #terminal: ((frame: TerminalNotification) => void) | null = null;
  #terminalDetach: ((request: ExecutorRpcMethods['terminals.detach']['request']) => Promise<unknown>) | null = null;
  #retired = false;
  #incomingOpen: boolean;
  #outgoingOpen: boolean;
  #reconciled = false;
  #sentReconcile = false;
  #installing = true;
  readonly #installation = { incoming: new Set<string>(), outgoing: new Set<string>() };
  readonly #recoveryResends = new Set<string>();
  #bulkControl: ((frame: BulkConnectionControl) => void) | null = null;
  #reconciliationComplete: (() => void) | null = null;
  readonly #unsubscribe: () => void;

  constructor(readonly transport: SessionTransport, continuity: ExecutorRpcContinuity = {}) {
    this.#incomingOpen = !continuity.recovering;
    this.#outgoingOpen = !continuity.recovering;
    this.#parked = continuity.parked ?? null;
    this.#journal = continuity.journal ?? null;
    this.#outgoingAdmission = continuity.admission?.outgoing ?? this.#parked?.admission ?? new RpcAdmission();
    this.#incomingAdmission = continuity.admission?.incoming ?? this.#journal?.admission ?? new RpcAdmission();
    this.#journalOwner = {
      lane: transport.lane,
      session: transport.id,
      offer: (payload) => {
        if (this.#retired || !this.transport.channel.canAdmit(payload)) return false;
        try { this.transport.send(payload); return true; } catch { return false; }
      },
    };
    this.#unsubscribe = transport.onMessage((payload) => this.#receive(payload));
    transport.onFailure(() => this.retireUnknown());
  }

  retireUnknown(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#bulkControl = null;
    this.#reconciliationComplete = null;
    this.#recoveryResends.clear();
    this.#unsubscribe();
    this.#handler = null;
    this.#producer = null;
    this.#producerAck = null;
    this.#terminal = null;
    this.#terminalDetach = null;
    if (this.#replyAckTimer) clearTimeout(this.#replyAckTimer);
    this.#replyAckTimer = null;
    this.#replyAcks = [];
    for (const call of this.#pending.values()) {
      if (call.journaled && this.#parked) {
        this.#parked.park(call);
        continue;
      }
      call.cleanup();
      call.reject(new ExecutorSessionLostError('unknown', 'The connection to the executor dropped before it replied.'));
    }
    this.#pending.clear();
    const lostLateResults = [...this.#lateResults.values()];
    this.#lateResults.clear();
    // A launch outlives its session; the producer relay reports its outcome.
    for (const { controller, continuity } of this.#incoming.values()) {
      if (continuity === 'session') controller.abort();
    }
    this.#incoming.clear();
    this.#journal?.ownerLost(this.#journalOwner);
    for (const { lost, release } of lostLateResults) {
      release();
      try { lost?.(); } catch (error) { log.warn('Failed to record a cancelled executor call whose late result was lost', error); }
    }
  }

  handle(handler: RpcHandler): void { this.#handler = handler; }
  get reconciled(): boolean { return this.#reconciled; }
  get active(): boolean { return !this.#retired && this.#outgoingOpen && this.transport.connected; }
  onBulkControl(handler: (frame: BulkConnectionControl) => void): void { this.#bulkControl = handler; }
  onReconciled(handler: () => void): void { this.#reconciliationComplete = handler; }
  activateIncoming(): void { this.#incomingOpen = true; this.#recoveryResends.clear(); }
  activate(): void { this.activateIncoming(); this.#outgoingOpen = true; this.#installing = false; }
  onProducer(handler: (frame: AgentProducerFrame) => void): void { this.#producer = handler; }
  onTerminal(handler: (frame: TerminalNotification) => void): void { this.#terminal = handler; }
  publishTerminal(frame: TerminalNotification): boolean {
    return !this.#retired && this.transport.channel.trySend(JSON.stringify(frame));
  }
  publishTerminalControl(frame: TerminalNotification): void {
    if (this.#retired || !this.transport.connected) return;
    try { this.transport.send(JSON.stringify(frame)); }
    catch { /* Continuity failure retires delivery, but must not interrupt native PTY draining. */ }
  }
  onTerminalDetach(handler: (request: ExecutorRpcMethods['terminals.detach']['request']) => Promise<unknown>): void { this.#terminalDetach = handler; }
  detachTerminal(request: ExecutorRpcMethods['terminals.detach']['request']): void {
    // Cleanup does not consume the RPC budget held by the work it is releasing.
    if (!this.#retired && this.transport.connected) this.transport.send(JSON.stringify({ type: 'terminal-detach', request } satisfies RpcFrame));
  }
  // Producer frames are encoded once by the worker's relay, which also retains
  // them for resume and offers refused frames again.
  offerProducer(payload: string): boolean {
    return !this.#retired && this.transport.channel.offer(payload);
  }
  onProducerAck(handler: (acknowledgements: readonly ProducerAcknowledgement[]) => void): void {
    this.#producerAck = handler;
  }
  acknowledgeProducers(acknowledgements: readonly ProducerAcknowledgement[]): void {
    if (this.#retired || !this.transport.connected || acknowledgements.length === 0) return;
    try { this.transport.send(JSON.stringify({ type: 'producer-ack', acknowledgements } satisfies RpcFrame)); }
    catch { /* Resume carries the same positions if the session is lost. */ }
  }

  async call<K extends keyof ExecutorRpcMethods>(
    integrationId: string, method: K, request: ExecutorRpcMethods[K]['request'], options?: RpcCallOptions<ExecutorRpcMethods[K]['result']>,
  ): Promise<ExecutorRpcMethods[K]['result']> {
    const timeoutMs = options?.timeoutMs === undefined ? DEFAULT_RPC_TIMEOUT_MS : options.timeoutMs;
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1)) {
      throw new AgentCallError('not-dispatched', 'Invalid executor deadline');
    }
    if (options?.signal?.aborted) throw new AgentCallError('not-dispatched', 'Executor is unavailable');
    if (this.#retired || !this.transport.connected) throw new ExecutorSessionLostError('not-dispatched', 'Executor is unavailable');
    assertRpcLane(method, request, this.transport.lane);
    if (!this.#outgoingOpen && method !== 'calls.reconcile') throw new AgentCallError('not-dispatched', 'Executor bulk connection is recovering');
    if (method === 'calls.reconcile') {
      if (this.#sentReconcile) throw new AgentCallError('not-dispatched', 'Session reconciliation already started');
      this.#sentReconcile = true;
    }
    const release = this.#installationCall('outgoing', method, integrationId) ? () => {} : this.#outgoingAdmission.acquire(this.transport.lane);
    let retainedForLateResult = false;
    const result = Promise.withResolvers<unknown>();
    const call: OutgoingCall = {
      id: crypto.randomUUID(), integrationId, method, request,
      journaled: this.#parked !== null && rpcContinuity(method) === 'journaled',
      session: this.transport.id, seq: 0, rpc: this, dispatchDeadline: options?.dispatchDeadline, expiry: null,
      resolve: result.resolve, reject: result.reject, cleanup: () => {}, expire: () => {},
    };
    const parked = this.#parked;
    const cancel = (message: string) => {
      const holder = call.rpc;
      if (holder ? holder.#pending.get(call.id) !== call : !parked?.release(call)) return;
      if (holder) holder.#pending.delete(call.id);
      // Resource-producing calls retain their budget until settlement or session loss.
      const onLateResult = options?.onLateResult;
      if (holder && onLateResult) {
        retainedForLateResult = true;
        holder.#lateResults.set(call.id, {
          release,
          receive: (value) => onLateResult(value as ExecutorRpcMethods[K]['result']),
          lost: options?.onLateResultLost,
        });
      }
      call.cleanup();
      call.reject(new AgentCallError('unknown', message));
      // A parked call's worker learns of it at the next reconcile, which does not name it.
      if (holder && !holder.#retired) {
        try { holder.transport.send(JSON.stringify({ type: 'cancel', id: call.id } satisfies RpcFrame)); } catch { /* Continuity failure already fences the call. */ }
      }
    };
    const timer = timeoutMs === null ? null : setTimeout(() => cancel('The executor did not reply in time.'), timeoutMs);
    timer?.unref();
    const abort = () => cancel('The request was cancelled after it was sent to the executor.');
    options?.signal?.addEventListener('abort', abort, { once: true });
    call.cleanup = () => {
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abort);
      disarmExpiry(call);
      if (!retainedForLateResult) release();
    };
    call.expire = () => cancel('The executor did not reconnect in time, so the outcome is unknown.');
    try {
      this.#dispatch(call);
    } catch (error) {
      call.cleanup();
      throw error;
    }
    return await result.promise as ExecutorRpcMethods[K]['result'];
  }

  // Settles the journaled calls lost sessions left outstanding, on a
  // replacement session of the same worker. The worker may send an adopted
  // call's reply right after answering, so every call is adopted before this
  // yields.
  async reconcileParked(): Promise<void> {
    const parked = this.#parked;
    const calls = parked?.take() ?? [];
    const reconciling = this.call('', 'calls.reconcile', {
      calls: calls.map(({ id, session, seq }): OutstandingCall => ({ id, session, seq })),
    });
    for (const call of calls) {
      if (this.#retired) parked?.park(call);
      else {
        call.rpc = this;
        this.#pending.set(call.id, call);
      }
    }
    const states = reconciledStates((await reconciling).states);
    for (const call of calls) {
      if (this.#pending.get(call.id) !== call) continue;
      const state = states.get(call.id);
      // The reply can be read after the call's dispatch deadline, before its expiry has run.
      const overdue = call.dispatchDeadline !== undefined && performance.now() >= call.dispatchDeadline;
      if (state === 'pending') {
        // A call still running on the worker stops waiting as its expiry would have stopped it.
        if (overdue) call.expire();
        else disarmExpiry(call);
        continue;
      }
      if (state === 'not-received') {
        // A call the worker never received is not sent after its deadline.
        if (overdue) {
          this.#pending.delete(call.id);
          call.cleanup();
          call.reject(reconnectTimedOut());
          continue;
        }
        disarmExpiry(call);
        try { this.#dispatch(call); }
        catch (error) {
          if (this.#pending.get(call.id) !== call) continue;
          this.#pending.delete(call.id);
          call.cleanup();
          call.reject(error instanceof Error ? error : new Error(String(error)));
        }
        continue;
      }
      this.#pending.delete(call.id);
      call.cleanup();
      call.reject(new ExecutorSessionLostError('unknown', 'The executor no longer holds the reply to this request.'));
    }
  }

  // Sends a call on this session: its first dispatch, or again once the worker
  // reports that a lost session never delivered it.
  #dispatch(call: OutgoingCall): void {
    const seq = this.#sent + 1;
    const payload = JSON.stringify({
      type: 'request', id: call.id, seq, integrationId: call.integrationId, method: call.method, request: call.request,
    });
    assertRpcRequestSize(call.method, this.transport.lane, Buffer.byteLength(payload));
    if (!this.transport.channel.fitsFrame(payload)) {
      throw new AgentCallError('not-dispatched', 'The request is too large to send to the executor.');
    }
    if (!this.transport.channel.canAdmit(payload)) {
      throw new AgentCallError('not-dispatched', 'The connection to the executor is backed up. Try again shortly.');
    }
    this.#sent = seq;
    call.rpc = this;
    call.session = this.transport.id;
    call.seq = seq;
    this.#pending.set(call.id, call);
    try {
      this.transport.send(payload);
    } catch {
      // A failed send retires the session first, which settles or parks the call.
      if (this.#pending.get(call.id) !== call) return;
      this.#pending.delete(call.id);
      call.cleanup();
      call.reject(new ExecutorSessionLostError('unknown', 'The connection to the executor dropped while the request was being sent.'));
    }
  }

  #receive(payload: string): void {
    if (this.#retired) return;
    const frame = parseFrame(payload);
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') throw new Error('Invalid executor RPC frame');
    if (frame.type.startsWith('bulk-')) {
      if (this.transport.lane !== 'primary' || Buffer.byteLength(payload) > BULK_CONTROL_BYTES || !this.#bulkControl) {
        throw new Error('Unexpected bulk connection control');
      }
      this.#bulkControl(parseBulkControl(frame));
      return;
    }
    if (this.transport.lane === 'bulk' && ['terminal', 'terminal-detach', 'producer', 'producer-ack'].includes(frame.type)) {
      throw new Error('Primary notification on the bulk lane');
    }
    if (frame.type === 'terminal') { this.#terminal?.(parseTerminalNotification(frame)); return; }
    if (frame.type === 'terminal-detach') {
      const handler = this.#terminalDetach;
      void Promise.resolve().then(() => !this.#retired && handler?.(frame.request)).catch(() => undefined);
      return;
    }
    if (frame.type === 'producer') {
      if (!this.#producer) throw new Error('Producer receiver is not installed');
      if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) throw new Error('Invalid producer sequence');
      this.#producer(frame);
      return;
    }
    if (frame.type === 'producer-ack') {
      if (!Array.isArray(frame.acknowledgements) || frame.acknowledgements.some((ack) => (
        !ack || typeof ack.bindingId !== 'string' || !Number.isSafeInteger(ack.seq) || ack.seq < 0
      ))) throw new Error('Invalid producer acknowledgement');
      this.#producerAck?.(frame.acknowledgements);
      return;
    }
    if (frame.type === 'reply-ack') {
      if (!Array.isArray(frame.ids) || frame.ids.some((id) => typeof id !== 'string')) throw new Error('Invalid reply acknowledgement');
      this.#journal?.acknowledge(this.#journalOwner, frame.ids);
      return;
    }
    if (!('id' in frame) || typeof frame.id !== 'string') throw new Error('RPC request ID is required');
    if (frame.type === 'result' || frame.type === 'error') {
      const call = this.#pending.get(frame.id);
      if (!call) {
        const late = this.#lateResults.get(frame.id);
        this.#lateResults.delete(frame.id);
        late?.release();
        if (frame.type === 'result' && late) {
          // The deferred callback owns cleanup after the map releases the budget slot.
          void Promise.resolve().then(() => {
            return this.#retired ? late.lost?.() : late.receive(frame.value);
          }).catch((error) => log.warn('Failed to clean up a cancelled executor call', error));
        }
        return;
      }
      let failure = frame.type === 'error' ? decodeFailure(frame.error) : null;
      try { assertRpcReplySize(call.method, call.request, this.transport.lane, Buffer.byteLength(payload)); }
      catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
      this.#pending.delete(frame.id); call.cleanup();
      // A worker keeps every journaled reply until it is acknowledged.
      if (rpcContinuity(call.method) === 'journaled') this.#acknowledgeReply(frame.id);
      if (failure) call.reject(failure);
      else if (frame.type === 'result') call.resolve(frame.value);
      return;
    }
    if (frame.type === 'cancel') {
      const incoming = this.#incoming.get(frame.id);
      if (incoming) incoming.controller.abort();
      else this.#journal?.cancel(this.#journalOwner, frame.id);
      return;
    }
    if (frame.type !== 'request' || typeof frame.integrationId !== 'string' || typeof frame.method !== 'string') {
      throw new Error('Invalid executor RPC request');
    }
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) throw new Error('Invalid RPC request sequence');
    // Tracking the highest sequence stays safe if another sender numbers the
    // same session: a request received is never reported as not received.
    this.#received = Math.max(this.#received, frame.seq);
    this.#journal?.received(this.#journalOwner, this.#received);
    if (this.#incoming.has(frame.id) || this.#journal?.has(frame.id)) throw new Error('Duplicate RPC request ID');
    try {
      assertRpcLane(frame.method, frame.request, this.transport.lane);
      assertRpcRequestSize(frame.method, this.transport.lane, Buffer.byteLength(payload));
    } catch (error) {
      this.#reply({ type: 'error', id: frame.id, error: encodeFailure(error) });
      return;
    }
    if (frame.method === 'calls.reconcile') {
      this.#reconcile(frame);
      return;
    }
    if (!this.#incomingOpen && (!this.#recoveryResends.delete(frame.id) || rpcContinuity(frame.method) !== 'journaled')) {
      this.#reply({ type: 'error', id: frame.id, error: encodeFailure(new AgentCallError('not-dispatched', 'Executor bulk connection is recovering')) });
      return;
    }
    let release: () => void;
    try {
      release = this.#installationCall('incoming', frame.method, frame.integrationId) ? () => {} : this.#incomingAdmission.acquire(this.transport.lane);
    } catch (error) {
      this.#reply({ type: 'error', id: frame.id, error: encodeFailure(error) });
      return;
    }
    const continuity = rpcContinuity(frame.method);
    if (continuity === 'journaled' && this.#journal) {
      this.#runJournaled(frame, this.#journal.begin(this.#journalOwner, frame.id), this.#journal, release);
      return;
    }
    const controller = new AbortController();
    this.#incoming.set(frame.id, { controller, continuity });
    const handler = this.#handler;
    let replyGuard: RpcReplyGuard | undefined;
    let undelivered: (() => void) | undefined;
    const current = () => !this.#retired && this.#incoming.get(frame.id)?.controller === controller;
    void Promise.resolve().then(() => {
      if (!current() || controller.signal.aborted) throw new AgentCallError('not-dispatched', 'RPC request cancelled before dispatch');
      if (!handler) throw new AgentCallError('not-dispatched', 'RPC receiver is not installed');
      return withActivity(rpcActivity(frame.method), () => handler(frame, controller.signal, (guard) => { replyGuard = guard; }, (listener) => { undelivered = listener; }));
    }).then((value) => {
      if (current() && !this.#reply({ type: 'result', id: frame.id, value }, this.#guardReply(frame, replyGuard))) undelivered?.();
    }, (error) => {
      logRedactedFailure(frame, error);
      if (current() && !this.#reply({ type: 'error', id: frame.id, error: encodeFailure(error) }, this.#guardReply(frame))) undelivered?.();
    }).catch(() => undefined).finally(() => {
      if (current()) this.#incoming.delete(frame.id);
      release();
    });
  }

  // Runs a journaled call to completion even if its session is lost; the
  // journal delivers the reply to whichever session owns the call by then.
  #runJournaled(frame: ExecutorRpcRequest, call: JournaledCall, journal: RpcReplyJournal, release: () => void): void {
    const handler = this.#handler;
    let replyGuard: RpcReplyGuard | undefined;
    void Promise.resolve().then(() => {
      if (call.signal.aborted) throw new AgentCallError('not-dispatched', 'RPC request cancelled before dispatch');
      if (!handler) throw new AgentCallError('not-dispatched', 'RPC receiver is not installed');
      // Only launches, which the journal does not carry, observe undelivered replies.
      return withActivity(rpcActivity(frame.method), () => handler(frame, call.signal, (guard) => { replyGuard = guard; }, () => {}));
    }).then(
      (value) => this.#encodeReply({ type: 'result', id: frame.id, value }, this.#guardReply(frame, replyGuard)) ?? undeliverableReply(frame.id),
      (error) => {
        logRedactedFailure(frame, error);
        return this.#encodeReply({ type: 'error', id: frame.id, error: encodeFailure(error) }, this.#guardReply(frame)) ?? undeliverableReply(frame.id);
      },
    ).catch((error) => JSON.stringify({ type: 'error', id: frame.id, error: encodeFailure(error) } satisfies RpcFrame))
      .then((reply) => journal.complete(call, reply, undeliverableReply(frame.id))).finally(release);
  }

  #reconcile(frame: Extract<ExecutorRpcRequest, { readonly method: 'calls.reconcile' }>): void {
    const calls: unknown = frame.request?.calls;
    if (this.#reconciled || !Array.isArray(calls) || calls.length > RPC_CALL_LIMIT || calls.some((call) => (
      !call || typeof call.id !== 'string' || typeof call.session !== 'string' || !Number.isSafeInteger(call.seq) || call.seq < 1
    ))) {
      this.#reply({ type: 'error', id: frame.id, error: encodeFailure(new AgentCallError('rejected', 'Invalid call reconciliation request')) });
      return;
    }
    const outstanding = calls as readonly OutstandingCall[];
    // Without a journal, no reply outlives its session.
    const states = this.#journal?.reconcile(this.#journalOwner, outstanding)
      ?? outstanding.map(({ id }): OutstandingCallState => ({ id, state: 'unknown' }));
    if (!this.#incomingOpen) {
      for (const { id, state } of states) if (state === 'not-received') this.#recoveryResends.add(id);
    }
    this.#reply({ type: 'result', id: frame.id, value: { states } });
    this.#reconciled = true;
    this.#reconciliationComplete?.();
    this.#journal?.deliver();
  }

  #installationCall(direction: 'incoming' | 'outgoing', method: string, integrationId: string): boolean {
    if (method === 'calls.reconcile') return true;
    if (!this.#installing || this.transport.lane !== 'primary' || !SESSION_INSTALLATION_METHODS.has(method)) return false;
    const seen = this.#installation[direction];
    const key = JSON.stringify([method, integrationId]);
    if (seen.has(key) || seen.size >= RPC_INSTALLATION_CALL_LIMIT) return false;
    seen.add(key);
    return true;
  }

  #guardReply(call: ExecutorRpcRequest, guard?: RpcReplyGuard): RpcReplyGuard {
    return (bytes) => {
      guard?.(bytes);
      assertRpcReplySize(call.method, call.request, this.transport.lane, bytes);
    };
  }

  #acknowledgeReply(id: string): void {
    this.#replyAcks.push(id);
    if (this.#replyAcks.length >= REPLY_ACK_BATCH) {
      this.#flushReplyAcks();
      return;
    }
    if (this.#replyAckTimer) return;
    this.#replyAckTimer = setTimeout(() => this.#flushReplyAcks(), REPLY_ACK_DELAY_MS);
    this.#replyAckTimer.unref?.();
  }

  #flushReplyAcks(): void {
    if (this.#replyAckTimer) clearTimeout(this.#replyAckTimer);
    this.#replyAckTimer = null;
    const ids = this.#replyAcks;
    this.#replyAcks = [];
    if (this.#retired || !this.transport.connected || ids.length === 0) return;
    try { this.transport.send(JSON.stringify({ type: 'reply-ack', ids } satisfies RpcFrame)); }
    catch { /* The next reconcile releases replies whose calls have settled. */ }
  }

  // Returns null for a reply too large to send.
  #encodeReply(frame: ReplyFrame, guard?: RpcReplyGuard): string | null {
    let payload = JSON.stringify(frame);
    if (guard) {
      try { guard(Buffer.byteLength(payload)); }
      catch (error) { payload = JSON.stringify({ type: 'error', id: frame.id, error: encodeFailure(error) } satisfies RpcFrame); }
    }
    return this.transport.channel.fitsFrame(payload) ? payload : null;
  }

  // Sends an unknown outcome in place of a reply that is too large or that the
  // session cannot take, since its operation may already have run. Returns
  // false when it did.
  #reply(frame: ReplyFrame, guard?: RpcReplyGuard): boolean {
    const payload = this.#encodeReply(frame, guard);
    const deliverable = payload !== null && this.transport.channel.canAdmit(payload);
    this.transport.send(deliverable ? payload : undeliverableReply(frame.id));
    return deliverable;
  }
}

// Names the frame instead of keeping the parse error, whose message can echo the payload.
function parseFrame(payload: string): RpcFrame {
  try { return JSON.parse(payload); }
  catch { throw new Error('Malformed executor RPC frame'); }
}

function undeliverableReply(id: string): string {
  return JSON.stringify({ type: 'error', id, error: encodeFailure(
    new AgentCallError('unknown', "The executor's reply could not be delivered, so the outcome is unknown."),
  ) } satisfies RpcFrame);
}

function reconciledStates(value: unknown): ReadonlyMap<string, OutstandingCallState['state']> {
  if (!Array.isArray(value) || value.some((state) => (
    !state || typeof state.id !== 'string' || !['pending', 'not-received', 'unknown'].includes(state.state)
  ))) throw new Error('Invalid call reconciliation reply');
  return new Map((value as readonly OutstandingCallState[]).map(({ id, state }) => [id, state]));
}

// An error reply carries a parse error only as Malformed data, so the side that threw
// logs which call failed and where.
function logRedactedFailure(frame: ExecutorRpcRequest, error: unknown): void {
  if (!(error instanceof SyntaxError)) return;
  log.warn('Executor call failed on malformed data', {
    callId: frame.id, integrationId: frame.integrationId, method: frame.method, reason: failureReason(error),
  });
}

function encodeFailure(error: unknown): Failure {
  if (error instanceof GitServiceError) return { domain: 'git', code: error.code, message: error.message, status: error.status, retryable: false };
  if (error instanceof TerminalError) return { domain: 'terminal', code: error.code, message: error.message, status: error.status, retryable: error.status >= 500 };
  if (error instanceof DomainError) return { domain: 'executor', code: error.code, message: error.message, status: error.status, retryable: error.retryable };
  if (error instanceof AgentIntegrationError) return {
    code: error.code, message: error.message, retryable: error.retryable,
    ...(error.details ? { details: error.details } : {}),
    ...(error instanceof AgentCallError ? { outcome: error.outcome } : {}),
  };
  // A parse error's message can echo the payload it failed on, so an error reply does not carry it.
  const message = error instanceof SyntaxError ? MALFORMED_DATA : error instanceof Error ? error.message : 'Provider operation failed';
  return { code: 'PROVIDER_FAILURE', message, retryable: false };
}

function decodeFailure(error: Failure): Error {
  if (!error || typeof error.message !== 'string' || typeof error.code !== 'string'
    || typeof error.retryable !== 'boolean'
    || (error.outcome !== undefined && !['unknown', 'not-dispatched', 'rejected'].includes(error.outcome))) {
    throw new Error('Invalid RPC error');
  }
  if (error.domain === 'executor') {
    if (!isErrorCode(error.code) || !Number.isInteger(error.status) || error.status! < 400 || error.status! > 599) throw new Error('Invalid executor RPC error');
    return new DomainError(error.code, error.message, error.status, error.retryable);
  }
  if (error.domain === 'git') {
    if (!isGitServiceErrorCode(error.code)) throw new Error('Invalid Git RPC error');
    return new GitServiceError(error.code, error.message);
  }
  if (error.domain === 'terminal') {
    if (!parseTerminalStreamServerMessage({ type: 'terminal-error', code: error.code, message: error.message })
      || !Number.isInteger(error.status) || error.status! < 400 || error.status! > 599) throw new Error('Invalid terminal RPC error');
    return new TerminalError(error.code as TerminalErrorCode, error.message, error.status);
  }
  if (error.domain !== undefined || !isAgentIntegrationErrorCode(error.code)) throw new Error('Invalid provider RPC error');
  return error.outcome
    ? new AgentCallError(error.outcome, error.message, error.code)
    : new AgentIntegrationError(error.code, error.message, error.retryable, error.details);
}

// Names the handled method in stall reports when it looks like an RPC method name.
function rpcActivity(method: unknown): string {
  return `rpc ${typeof method === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(method) ? method : 'unknown'}`;
}
