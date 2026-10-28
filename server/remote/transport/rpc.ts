import { encodeFailure, decodeFailure, assertFailureEnvelope, resultFailure, type Failure } from './rpc-failure.js';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import {
  AgentCallError, type ExecutorCallOptions,
} from '@garcon/server-agent-interface';
import {
  rpcContinuity,
  SESSION_INSTALLATION_METHODS,
  type ExecutorRpcMethods, type ExecutorRpcRequest, type RpcContractRef, type RpcRequest, type RpcResult, type AgentProducerFrame, type ProducerAckFrame, type ProducerAcknowledgement,
  type OutstandingCall, type OutstandingCallState, type ReplyAckFrame, type RpcContinuity,
} from './rpc-protocol.js';
import type { SessionTransport } from './session-transport.js';
import type { JournaledCall, RpcJournalOwner, RpcReplyJournal } from './rpc-journal.js';
import { ExecutorSessionLostError, reconnectTimedOut } from '../../common/executor-disconnect.js';
import { withActivity } from '../../common/event-loop-stalls.js';
import { createLogger } from '../../common/log.js';
import { failureReason } from './failure-reason.js';
import { contractKey, isContractName, supportsDefinition } from '@garcon/common/protocol-contracts';
import type { TerminalNotification } from './terminal-protocol.js';
import { RpcAdmission, type RpcAdmissionBudgets } from './rpc-admission.js';
import { parseBulkControl, type BulkConnectionControl } from './rpc-lane.js';
import { BULK_CONTROL_BYTES, RPC_CALL_LIMIT, RPC_INSTALLATION_CALL_LIMIT } from './limits.js';
import { sameContinuity, type SessionProtocol } from './protocol-compatibility.js';
import { registerRpcHandlers, resolveRpc, type BoundRpcHandlers, type RpcHandler, type RpcCallCapture, type RpcWire } from './rpc-registrations.js';
import { rpcWireV1 } from './rpc-wire-v1.js';


type ReplyFrame =
  | { readonly type: 'result'; readonly id: string; readonly value: unknown }
  | { readonly type: 'error'; readonly id: string; readonly error: Failure };

type RpcFrame = ExecutorRpcRequest | AgentProducerFrame | ProducerAckFrame | ReplyAckFrame | TerminalNotification | ReplyFrame | BulkConnectionControl
  | { readonly type: 'terminal-detach'; readonly request: ExecutorRpcMethods['terminals.detach']['request'] }
  | { readonly type: 'cancel'; readonly id: string };

export interface RpcCallOptions<Result = unknown> extends Omit<ExecutorCallOptions, 'timeoutMs'> {
  readonly timeoutMs?: number | null;
  readonly onLateResult?: (value: Result) => void | Promise<unknown>;
  readonly onLateError?: (error: Error) => void;
  // Runs when the session is lost before a cancelled call's late cleanup begins.
  readonly onLateResultLost?: () => void;
}

interface LateResult {
  readonly capture: RpcCallCapture;
  readonly release: () => void;
  readonly prepare: (value: unknown) => () => void | Promise<unknown>;
  readonly failed: ((error: Error) => void) | undefined;
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

interface OutgoingCall {
  readonly id: string;
  readonly integrationId: string;
  readonly capture: RpcCallCapture;
  readonly encodedRequest: string;
  readonly journaled: boolean;
  readonly protocol: SessionProtocol;
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
  readonly capture: RpcCallCapture;
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
  readonly #settledCalls = new Map<string, RpcCallCapture>();
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
  readonly #handlers = new Map<string, RpcHandler>();
  #assertDispatch: (() => void) | null = null;
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
      continuity: transport.continuity,
      offer: (payload) => {
        if (this.#retired || !this.transport.channel.canAdmit(payload)) return false;
        try { this.transport.send(payload); return true; } catch { return false; }
      },
    };
    this.#unsubscribe = transport.onMessage((payload) => this.#receive(payload));
    transport.onFailure(() => this.retireUnknown());
    if (transport.protocol.contracts.receiver(RPC_V1['calls.reconcile'])?.registration === TRANSPORT_RPC_HANDLERS) {
      this.handle(TRANSPORT_RPC_HANDLERS.bind((call, capture) => this.#reconcile(call, capture)));
    }
  }

  retireUnknown(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#bulkControl = null;
    this.#reconciliationComplete = null;
    this.#recoveryResends.clear();
    this.#unsubscribe();
    this.#handlers.clear();
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
    this.#settledCalls.clear();
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

  handle(bound: BoundRpcHandlers): void {
    for (const wire of bound.registration.wires) {
      const receiver = this.transport.protocol.contracts.receiver(wire.definition);
      if (receiver?.registration !== bound.registration) throw new Error('RPC handler was not registered in this role offer');
      this.#handlers.set(contractKey(wire.definition), bound.handle);
    }
  }
  guardDispatch(assertCurrent: () => void): void { this.#assertDispatch = assertCurrent; }
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
  detachTerminal(contract: RpcContractRef<'terminals.detach'>, request: ExecutorRpcMethods['terminals.detach']['request']): void {
    resolveRpc(this.transport.protocol, contract, 'send');
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

  async call<D extends RpcContractRef>(
    integrationId: string, contract: D, request: NoInfer<RpcRequest<D>>, options?: RpcCallOptions<NoInfer<RpcResult<D>>>,
  ): Promise<RpcResult<D>> {
    const method = contract.name;
    const timeoutMs = options?.timeoutMs === undefined ? DEFAULT_RPC_TIMEOUT_MS : options.timeoutMs;
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1)) {
      throw new AgentCallError('not-dispatched', 'Invalid executor deadline');
    }
    if (options?.signal?.aborted) throw new AgentCallError('not-dispatched', 'Executor is unavailable');
    if (this.#retired || !this.transport.connected) throw new ExecutorSessionLostError('not-dispatched', 'Executor is unavailable');
    this.#assertDispatch?.();
    const wire = resolveRpc(this.transport.protocol, contract, 'send');
    let capture: RpcCallCapture;
    let encodedRequest: string;
    try {
      const parsedRequest = wire.request(request);
      capture = Object.freeze({ wire, protocol: this.transport.protocol,
        policy: wire.policy(parsedRequest, this.transport.lane, this.transport.protocol.contracts) });
      encodedRequest = JSON.stringify(parsedRequest);
      if (encodedRequest === undefined) throw new Error('Missing request');
    } catch (error) {
      if (error instanceof AgentCallError || encodeFailure(error).domain) throw error;
      throw new AgentCallError('not-dispatched', 'Invalid executor request');
    }
    if (!this.#outgoingOpen && method !== 'calls.reconcile') throw new AgentCallError('not-dispatched', 'Executor bulk connection is recovering');
    if (method === 'calls.reconcile') {
      if (this.#sentReconcile) throw new AgentCallError('not-dispatched', 'Session reconciliation already started');
      this.#sentReconcile = true;
    }
    const release = this.#installationCall('outgoing', method, integrationId) ? () => {} : this.#outgoingAdmission.acquire(this.transport.lane);
    let retainedForLateResult = false;
    const result = Promise.withResolvers<RpcResult<D>>();
    const call: OutgoingCall = {
      id: crypto.randomUUID(), integrationId, capture, encodedRequest,
      protocol: this.transport.protocol,
      journaled: this.#parked !== null && wire.definition.continuity === 'journaled',
      session: this.transport.id, seq: 0, rpc: this, dispatchDeadline: options?.dispatchDeadline, expiry: null,
      resolve: value => {
        try { result.resolve(wire.result(value)); }
        catch (error) { result.reject(resultFailure(error)); }
      },
      reject: result.reject, cleanup: () => {}, expire: () => {},
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
          capture: call.capture,
          release,
          prepare: value => {
            const decoded = wire.result(value);
            return () => onLateResult(decoded);
          },
          failed: options?.onLateError,
          lost: options?.onLateResultLost,
        });
      } else if (holder) holder.#rememberCall(call.id, call.capture);
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
    return await result.promise;
  }

  // Settles the journaled calls lost sessions left outstanding, on a
  // replacement session of the same worker. The worker may send an adopted
  // call's reply right after answering, so every call is adopted before this
  // yields.
  async reconcileParked(): Promise<void> {
    const parked = this.#parked;
    const calls = (parked?.take() ?? []).filter(call => {
      if (sameContinuity(call.protocol.continuity, this.transport.continuity)) return true;
      call.cleanup();
      call.reject(new ExecutorSessionLostError('unknown', 'The executor continuity changed before its reply was recovered.'));
      return false;
    });
    if (!supportsDefinition(this.transport.profile.contracts, RPC_V1['calls.reconcile'])) {
      for (const call of calls) {
        call.cleanup();
        call.reject(new AgentCallError('unknown', 'Call reconciliation is unavailable'));
      }
      return;
    }
    const reconciling = this.call('', RPC_V1['calls.reconcile'], {
      calls: calls.map(({ id, session, seq }): OutstandingCall => ({ id, session, seq })),
    });
    for (const call of calls) {
      if (this.#retired) parked?.park(call);
      else {
        call.rpc = this;
        this.#pending.set(call.id, call);
      }
    }
    const states = reconciledStates((await reconciling).states, calls);
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
    if (!sameContinuity(call.protocol.continuity, this.transport.continuity)) {
      throw new ExecutorSessionLostError('unknown', 'A call cannot be replayed in another executor continuity.');
    }
    this.#assertDispatch?.();
    const { wire, policy } = call.capture;
    if (!supportsDefinition(call.protocol.profile.contracts, wire.definition)) throw new AgentCallError('not-dispatched', 'Operation unsupported', 'OPERATION_UNSUPPORTED');
    const seq = this.#sent + 1;
    const envelope = JSON.stringify({ type: 'request', id: call.id, seq, integrationId: call.integrationId,
      method: wire.definition.name, version: wire.definition.version });
    const payload = `${envelope.slice(0, -1)},"request":${call.encodedRequest}}`;
    policy.requestSize(Buffer.byteLength(payload));
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
    if (frame.type === 'terminal') {
      if (typeof frame.attachmentId !== 'string' || !frame.attachmentId || frame.attachmentId.length > 256) throw new Error('Invalid terminal attachment ID');
      this.#terminal?.(frame);
      return;
    }
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
        const capture = late?.capture ?? this.#settledCalls.get(frame.id);
        let receiveLate: (() => void | Promise<unknown>) | undefined;
        let lateFailure: Error | undefined;
        let unreadable = false;
        if (frame.type === 'error') {
          if (capture) lateFailure = capture.wire.failure(frame.error);
          else assertFailureEnvelope(frame.error);
        }
        try {
          if (late && frame.type === 'result') receiveLate = late.prepare(frame.value);
          capture?.policy.replySize(Buffer.byteLength(payload));
        } catch { unreadable = true; }
        this.#lateResults.delete(frame.id);
        late?.release();
        if (capture) {
          this.#rememberCall(frame.id, capture);
          if (capture.wire.definition.continuity === 'journaled') this.#acknowledgeReply(frame.id);
        }
        if (frame.type === 'result' && late) {
          // The deferred callback owns cleanup after the map releases the budget slot.
          void Promise.resolve().then(() => {
            return this.#retired || unreadable ? late.lost?.() : receiveLate?.();
          }).catch((error) => log.warn('Failed to clean up a cancelled executor call', error));
        } else if (lateFailure && late?.failed) {
          try { late.failed(lateFailure); }
          catch (error) { log.warn('Failed to settle a cancelled executor call', error); }
        }
        return;
      }
      let failure = frame.type === 'error' ? call.capture.wire.failure(frame.error) : null;
      try { call.capture.policy.replySize(Buffer.byteLength(payload)); }
      catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
      this.#pending.delete(frame.id); call.cleanup();
      this.#rememberCall(frame.id, call.capture);
      // A worker keeps every journaled reply until it is acknowledged.
      if (call.capture.wire.definition.continuity === 'journaled') this.#acknowledgeReply(frame.id);
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
    if (frame.type !== 'request' || typeof frame.integrationId !== 'string' || !isContractName(frame.method)) {
      throw new Error('Invalid executor RPC request');
    }
    this.#request(frame, payload);
  }

  #request(frame: ExecutorRpcRequest, payload: string): void {
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) throw new Error('Invalid RPC request sequence');
    if (!Number.isInteger(frame.version) || frame.version < 1 || frame.version > 65535) throw new Error('Invalid RPC contract version');
    if (this.#incoming.has(frame.id) || this.#journal?.has(frame.id)) throw new Error('Duplicate RPC request ID');
    let capture: RpcCallCapture;
    let resolvedWire: RpcWire | undefined;
    try {
      const wire = resolveRpc(this.transport.protocol, { name: frame.method, version: frame.version }, 'receive');
      resolvedWire = wire;
      const request = wire.request(frame.request);
      capture = Object.freeze({ wire, protocol: this.transport.protocol,
        policy: wire.policy(request, this.transport.lane, this.transport.protocol.contracts) });
      capture.policy.requestSize(Buffer.byteLength(payload));
      frame = { ...frame, request } as ExecutorRpcRequest;
    } catch (error) {
      this.#reply({ type: 'error', id: frame.id, error: encodeFailure(error) }, undefined, resolvedWire ? { wire: resolvedWire } : undefined);
      return;
    }
    // Rejected protocol traffic never acquires receipt or journal ownership.
    this.#received = Math.max(this.#received, frame.seq);
    this.#journal?.received(this.#journalOwner, this.#received);
    if (frame.method === 'calls.reconcile') {
      const handler = this.#handlers.get(contractKey(capture.wire.definition));
      if (!handler) throw new Error('RPC reconciliation is not installed');
      void handler(frame, new AbortController().signal, () => {}, () => {}, capture).catch(error => this.transport.close(error));
      return;
    }
    if (!this.#incomingOpen && (!this.#recoveryResends.delete(frame.id) || capture.wire.definition.continuity !== 'journaled')) {
      this.#reply({ type: 'error', id: frame.id, error: encodeFailure(new AgentCallError('not-dispatched', 'Executor bulk connection is recovering')) }, undefined, capture);
      return;
    }
    let release: () => void;
    try {
      release = this.#installationCall('incoming', frame.method, frame.integrationId) ? () => {} : this.#incomingAdmission.acquire(this.transport.lane);
    } catch (error) {
      this.#reply({ type: 'error', id: frame.id, error: encodeFailure(error) }, undefined, capture);
      return;
    }
    const continuity = capture.wire.definition.continuity;
    if (continuity === 'journaled' && this.#journal) {
      this.#runJournaled(frame, this.#journal.begin(this.#journalOwner, frame.id, capture), this.#journal, release);
      return;
    }
    const controller = new AbortController();
    this.#incoming.set(frame.id, { controller, continuity, capture });
    const handler = this.#handlers.get(contractKey(capture.wire.definition));
    let replyGuard: RpcReplyGuard | undefined;
    let undelivered: (() => void) | undefined;
    const current = () => !this.#retired && this.#incoming.get(frame.id)?.controller === controller;
    void Promise.resolve().then(() => {
      if (!current() || controller.signal.aborted) throw new AgentCallError('not-dispatched', 'RPC request cancelled before dispatch');
      if (!handler) throw new AgentCallError('not-dispatched', 'RPC receiver is not installed');
      return withActivity(rpcActivity(frame.method), () => handler(frame, controller.signal, (guard) => { replyGuard = guard; }, (listener) => { undelivered = listener; }, capture));
    }).then((value) => {
      if (current() && !this.#reply({ type: 'result', id: frame.id, value }, this.#guardReply(capture, replyGuard), capture)) undelivered?.();
    }, (error) => {
      logRedactedFailure(frame, error);
      if (current() && !this.#reply({ type: 'error', id: frame.id, error: encodeFailure(error) }, this.#guardReply(capture), capture)) undelivered?.();
    }).catch(() => undefined).finally(() => {
      if (current()) this.#incoming.delete(frame.id);
      release();
    });
  }

  // Runs a journaled call to completion even if its session is lost; the
  // journal delivers the reply to whichever session owns the call by then.
  #runJournaled(frame: ExecutorRpcRequest, call: JournaledCall, journal: RpcReplyJournal, release: () => void): void {
    const { capture } = call;
    const handler = this.#handlers.get(contractKey(capture.wire.definition));
    const undeliverable = this.#undeliverableReply(frame.id, capture);
    let replyGuard: RpcReplyGuard | undefined;
    void Promise.resolve().then(() => {
      if (call.signal.aborted) throw new AgentCallError('not-dispatched', 'RPC request cancelled before dispatch');
      if (!handler) throw new AgentCallError('not-dispatched', 'RPC receiver is not installed');
      // Only launches, which the journal does not carry, observe undelivered replies.
      return withActivity(rpcActivity(frame.method), () => handler(frame, call.signal, (guard) => { replyGuard = guard; }, () => {}, capture));
    }).then(
      (value) => this.#encodeReply({ type: 'result', id: frame.id, value }, this.#guardReply(capture, replyGuard), capture) ?? undeliverable,
      (error) => {
        logRedactedFailure(frame, error);
        return this.#encodeReply({ type: 'error', id: frame.id, error: encodeFailure(error) }, this.#guardReply(capture), capture) ?? undeliverable;
      },
    ).catch((error) => this.#encodeReply({ type: 'error', id: frame.id, error: encodeFailure(error) }, undefined, capture) ?? undeliverable)
      .then((reply) => journal.complete(call, reply, undeliverable)).finally(release);
  }

  #reconcile(frame: Extract<ExecutorRpcRequest, { readonly method: 'calls.reconcile' }>, capture: RpcCallCapture): void {
    const calls: unknown = frame.request?.calls;
    if (this.#reconciled || !Array.isArray(calls) || calls.length > RPC_CALL_LIMIT || calls.some((call) => (
      !call || typeof call.id !== 'string' || typeof call.session !== 'string' || !Number.isSafeInteger(call.seq) || call.seq < 1
    ))) {
      this.#reply({ type: 'error', id: frame.id, error: encodeFailure(new AgentCallError('rejected', 'Invalid call reconciliation request')) }, this.#guardReply(capture), capture);
      return;
    }
    const outstanding = calls as readonly OutstandingCall[];
    // Without a journal, no reply outlives its session.
    const states = this.#journal?.reconcile(this.#journalOwner, outstanding)
      ?? outstanding.map(({ id }): OutstandingCallState => ({ id, state: 'unknown' }));
    if (!this.#incomingOpen) {
      for (const { id, state } of states) if (state === 'not-received') this.#recoveryResends.add(id);
    }
    this.#reply({ type: 'result', id: frame.id, value: { states } }, this.#guardReply(capture), capture);
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

  #guardReply(capture: RpcCallCapture, guard?: RpcReplyGuard): RpcReplyGuard {
    return (bytes) => {
      guard?.(bytes);
      capture.policy.replySize(bytes);
    };
  }

  #rememberCall(id: string, capture: RpcCallCapture): void {
    this.#settledCalls.delete(id);
    this.#settledCalls.set(id, capture);
    if (this.#settledCalls.size > RPC_CALL_LIMIT) this.#settledCalls.delete(this.#settledCalls.keys().next().value!);
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

  // Null preserves the undelivered observer, including live-session launch settlement.
  #encodeReply(frame: ReplyFrame, guard?: RpcReplyGuard, capture?: Pick<RpcCallCapture, 'wire'>): string | null {
    let payload: string;
    try {
      if (frame.type === 'error') (capture?.wire.failure ?? decodeFailure)(frame.error);
      else if (capture) {
        try { frame = { ...frame, value: capture.wire.result(frame.value) }; }
        catch (error) {
          const failure = encodeFailure(error);
          if (failure.domain) return this.#encodeReply({ type: 'error', id: frame.id, error: failure }, undefined, capture);
          throw error;
        }
      }
      payload = JSON.stringify(frame);
    } catch {
      log.warn('Unrepresentable RPC reply', { contract: capture ? contractKey(capture.wire.definition) : 'bootstrap',
        code: frame.type === 'error' ? String(frame.error.code).slice(0, 64) : 'INVALID_RESULT' });
      return null;
    }
    if (guard) {
      try { guard(Buffer.byteLength(payload)); }
      catch (error) { return this.#encodeReply({ type: 'error', id: frame.id, error: encodeFailure(error) }, undefined, capture); }
    }
    return this.transport.channel.fitsFrame(payload) ? payload : null;
  }

  #undeliverableReply(id: string, capture?: Pick<RpcCallCapture, 'wire'>): string {
    return this.#encodeReply({ type: 'error', id, error: encodeFailure(
      new AgentCallError('unknown', "The executor's reply could not be delivered, so the outcome is unknown."),
    ) }, undefined, capture)!;
  }

  // Sends an unknown outcome in place of a reply that is too large or that the
  // session cannot take, since its operation may already have run. Returns
  // false when it did.
  #reply(frame: ReplyFrame, guard?: RpcReplyGuard, capture?: Pick<RpcCallCapture, 'wire'>): boolean {
    const payload = this.#encodeReply(frame, guard, capture);
    const deliverable = payload !== null && this.transport.channel.canAdmit(payload);
    this.transport.send(deliverable ? payload : this.#undeliverableReply(frame.id, capture));
    return deliverable;
  }
}

export const TRANSPORT_RPC_CLIENTS = Object.freeze([rpcWireV1('calls.reconcile')] as const);
export const TRANSPORT_RPC_HANDLERS = registerRpcHandlers(TRANSPORT_RPC_CLIENTS,
  (reconcile: (call: Extract<ExecutorRpcRequest, { method: 'calls.reconcile' }>, capture: RpcCallCapture) => void,
    call, _signal, _guard, _undelivered, capture) => {
    reconcile(call, capture);
    return Promise.resolve();
  });

// Names the frame instead of keeping the parse error, whose message can echo the payload.
function parseFrame(payload: string): RpcFrame {
  try { return JSON.parse(payload); }
  catch { throw new Error('Malformed executor RPC frame'); }
}

function reconciledStates(value: unknown, calls: readonly Pick<OutstandingCall, 'id'>[]): ReadonlyMap<string, OutstandingCallState['state']> {
  const expected = new Set(calls.map(call => call.id));
  if (!Array.isArray(value) || value.some((state) => (
    !state || typeof state.id !== 'string' || !expected.delete(state.id) || !['pending', 'not-received', 'unknown'].includes(state.state)
  )) || expected.size !== 0) throw new Error('Invalid call reconciliation reply');
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

// Names the handled method in stall reports when it looks like an RPC method name.
function rpcActivity(method: unknown): string {
  return `rpc ${typeof method === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(method) ? method : 'unknown'}`;
}
