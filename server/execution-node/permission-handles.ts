import { createHash, randomUUID } from 'node:crypto';
import { parseProducerStreamIdentity, producerStreamKey, type AgentPermissionResponseCapability, type ProducerStreamIdentity } from '@garcon/server-agent-interface';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import { stableJsonStringify } from '../../common/json.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import {
  parseNodePermissionDecision, parseNodePermissionReference,
  type NodePermissionCommand, type NodePermissionReceipt, type NodePermissionReference, type NodePermissionResult,
} from '../execution-nodes/transport/permission-wire.js';
import { DomainError } from '../lib/domain-error.js';
import type { NodeOutputPermissionHandles } from './output-stream.js';
import { NodeAuthorityError, type NodeConnectionLease, type NodeSupervisor } from './supervisor.js';
import { MAX_NODE_STREAM_IDENTITIES, NodeStreamIdentityExhaustedError } from './replay-cache.js';

interface PermissionStream {
  isRunLive(runId: string): boolean;
  detach(): void;
}

interface PermissionEntry {
  readonly permission: NodePermissionReference;
  phase: NodePermissionReceipt['phase'];
  respond: AgentPermissionResponseCapability['respond'] | null;
  fingerprint: string | null;
  pending: Promise<void> | null;
  isRunLive: ((runId: string) => boolean) | null;
}

interface PermissionReceipt {
  readonly permission: NodePermissionReference;
  readonly phase: 'resolved' | 'expired' | 'unknown';
  readonly fingerprint: string | null;
  readonly expiresAt: number;
}

export interface NodePermissionHandlesOptions {
  readonly session: NodeSessionIdentity;
  readonly signal: AbortSignal;
  readonly supervisor: Pick<NodeSupervisor, 'assertConnection' | 'assertAdmission' | 'poll'>;
  readonly maxHandles?: number;
  readonly maxStreams?: number;
  readonly maxPendingResponses?: number;
  readonly maxReceipts?: number;
  readonly receiptMs?: number;
}

/** Retains live native authority separately from bounded terminal reconciliation receipts. */
export class NodePermissionHandles implements NodeOutputPermissionHandles {
  readonly #session: NodeSessionIdentity;
  readonly #entries = new Map<string, PermissionEntry>();
  readonly #receipts = new Map<string, PermissionReceipt>();
  readonly #minted = new Map<string, number>();
  readonly #occurrences = new Set<string>();
  readonly #streams = new Map<string, PermissionStream | null>();
  readonly #closing = new AbortController();
  readonly #detach: () => void;
  readonly #maxHandles: number;
  readonly #maxStreams: number;
  readonly #maxPendingResponses: number;
  readonly #maxReceipts: number;
  readonly #receiptMs: number;
  #registering = 0;
  #pendingResponses = 0;
  #closed = false;

  constructor(private readonly options: NodePermissionHandlesOptions) {
    const session = parseNodeSessionIdentity(options.session);
    if (!session) throw new TypeError('Invalid permission registry session');
    this.#session = Object.freeze(session);
    this.#maxHandles = options.maxHandles ?? 16_384;
    this.#maxStreams = options.maxStreams ?? MAX_NODE_STREAM_IDENTITIES;
    this.#maxPendingResponses = options.maxPendingResponses ?? 64;
    this.#maxReceipts = options.maxReceipts ?? 1_024;
    this.#receiptMs = options.receiptMs ?? 300_000;
    if (![this.#maxHandles, this.#maxStreams, this.#maxPendingResponses, this.#maxReceipts].every((limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 65_536)
      || !Number.isSafeInteger(this.#receiptMs) || this.#receiptMs < 1) throw new TypeError('Invalid permission registry limits');
    const close = () => this.close();
    options.signal.addEventListener('abort', close, { once: true });
    this.#detach = () => options.signal.removeEventListener('abort', close);
    if (options.signal.aborted) this.close();
  }

  install(stream: ProducerStreamIdentity, signal: AbortSignal, isRunLive: (runId: string) => boolean): void {
    this.#poll();
    const identity = parseProducerStreamIdentity(stream);
    if (!identity || !sameNodeSession(identity, this.#session)) throw expired();
    const key = producerStreamKey(identity);
    if (this.#streams.has(key)) throw new TypeError('Permission stream cannot be rebound');
    if (this.#streams.size >= this.#maxStreams) throw new NodeStreamIdentityExhaustedError();
    signal.throwIfAborted();
    const retire = () => this.retire(identity);
    this.#streams.set(key, { isRunLive, detach: () => signal.removeEventListener('abort', retire) });
    signal.addEventListener('abort', retire, { once: true });
  }

  createHandle(): string {
    const now = this.#poll();
    if (this.#entries.size + this.#minted.size + this.#registering >= this.#maxHandles) throw capacity();
    const handle = randomUUID();
    this.#minted.set(handle, now + this.#receiptMs);
    return handle;
  }

  register(stream: ProducerStreamIdentity, handle: string, decision: AgentPermissionResponseCapability, runId: string,
    isRunLive?: (runId: string) => boolean): void {
    this.#poll();
    if (!this.#minted.delete(handle)) throw new TypeError('Permission handle was not minted or cannot be rebound');
    this.#registering += 1;
    let occurrence: string | null = null;
    try {
      const permission = parseNodePermissionReference({ stream, handle, runId, permissionOccurrenceId: decision.permissionOccurrenceId });
      const respond = decision.respond;
      if (!permission || !sameNodeSession(permission.stream, this.#session) || typeof respond !== 'function') throw new TypeError('Invalid permission registration');
      const owner = this.#streams.get(producerStreamKey(permission.stream));
      if (!owner) throw expired();
      if (this.#occurrences.has(permission.permissionOccurrenceId)) throw new TypeError('Permission occurrence cannot be rebound');
      occurrence = permission.permissionOccurrenceId;
      this.#occurrences.add(occurrence);
      const live = this.#isRunLive(permission) && (isRunLive?.(runId) ?? true);
      if (this.#closed || this.#streams.get(producerStreamKey(permission.stream)) !== owner) throw expired();
      const entry: PermissionEntry = { permission, phase: live ? 'available' : 'expired',
        respond: live ? (payload) => Reflect.apply(respond, decision, [payload]) : null, fingerprint: null, pending: null,
        isRunLive: isRunLive ?? null };
      this.#entries.set(handle, entry);
      if (!live) this.#settle(entry, 'expired');
    } finally {
      this.#registering -= 1;
      if (occurrence !== null && !this.#entries.has(handle) && !this.#receipts.has(handle)) this.#occurrences.delete(occurrence);
    }
  }

  async execute(connection: NodeConnectionLease, command: NodePermissionCommand, signal: AbortSignal): Promise<NodePermissionResult> {
    try {
      this.#poll();
      this.options.supervisor.assertConnection(connection);
      if (!sameNodeSession(connection.session, this.#session)) throw expired();
      const permission = parseNodePermissionReference(command.permission);
      if (!permission || !sameNodeSession(permission.stream, this.#session)) throw expired();
      let entry = this.#entries.get(permission.handle);
      if (entry) this.#refresh(entry);
      entry = this.#entries.get(permission.handle);
      const receipt = this.#receipts.get(permission.handle);
      const record = entry ?? receipt;
      if (!record || !samePermission(record.permission, permission)) return { kind: 'permission', receipt: null };
      if (command.method === 'permission-status') return snapshot(record);
      this.options.supervisor.assertAdmission(connection);
      signal.throwIfAborted();
      const decision = parseNodePermissionDecision(command.decision);
      if (!decision) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
      const fingerprint = createHash('sha256').update(stableJsonStringify(decision)).digest('hex');
      if (record.fingerprint !== null && record.fingerprint !== fingerprint) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
      if (!entry) return snapshot(record);
      if (entry.phase === 'available') this.#respond(entry, decision, fingerprint);
      if (entry.pending) {
        const wait = AbortSignal.any([signal, connection.signal, this.#closing.signal]);
        try { await awaitResponse(entry.pending, wait); }
        catch { return { kind: 'unknown' }; }
      }
      return snapshot(entry);
    } catch (error) {
      if (error instanceof NodeAuthorityError && (error.code === 'NODE_SESSION_EXPIRED' || error.code === 'NODE_UNAVAILABLE')) return { kind: 'rejected', code: error.code };
      if (error instanceof DomainError && error.code === 'NODE_CAPACITY') return { kind: 'rejected', code: error.code };
      return { kind: 'unknown' };
    }
  }

  retireOccurrence(stream: ProducerStreamIdentity, runId: string, occurrence: string, owner: PermissionEntry['isRunLive'] = null): void {
    for (const entry of this.#entries.values()) if (producerStreamKey(entry.permission.stream) === producerStreamKey(stream)
      && entry.isRunLive === owner && entry.permission.runId === runId && entry.permission.permissionOccurrenceId === occurrence) this.#expire(entry);
  }

  retireRun(stream: ProducerStreamIdentity, runId: string, owner: PermissionEntry['isRunLive'] = null): void {
    for (const entry of this.#entries.values()) if (producerStreamKey(entry.permission.stream) === producerStreamKey(stream)
      && entry.isRunLive === owner && entry.permission.runId === runId) this.#expire(entry);
  }

  retire(stream: ProducerStreamIdentity): void {
    const key = producerStreamKey(stream);
    const owner = this.#streams.get(key);
    if (!owner) return;
    this.#streams.set(key, null);
    owner.detach();
    for (const entry of this.#entries.values()) if (producerStreamKey(entry.permission.stream) === key) this.#expire(entry);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing.abort(expired());
    this.#detach();
    for (const owner of this.#streams.values()) owner?.detach();
    this.#streams.clear();
    for (const entry of this.#entries.values()) this.#expire(entry);
    this.#entries.clear();
    this.#receipts.clear();
    this.#minted.clear();
    this.#occurrences.clear();
  }

  #respond(entry: PermissionEntry, decision: PermissionDecisionPayload, fingerprint: string): void {
    // Unsettled native responses retain their slots even after caller cancellation or receipt expiry.
    if (this.#pendingResponses >= this.#maxPendingResponses) throw capacity();
    this.#pendingResponses += 1;
    const respond = entry.respond!;
    entry.respond = null;
    entry.fingerprint = fingerprint;
    entry.phase = 'pending';
    const completion = Promise.withResolvers<void>();
    entry.pending = completion.promise;
    // Claims before invoking provider code, including synchronous reentrant output or a throwing callback.
    try {
      void Promise.resolve(respond(decision)).then(() => { this.#settle(entry, 'resolved'); }, () => { this.#settle(entry, 'unknown'); })
        .finally(() => { this.#pendingResponses -= 1; entry.pending = null; completion.resolve(); });
    } catch { this.#pendingResponses -= 1; this.#settle(entry, 'unknown'); entry.pending = null; completion.resolve(); }
  }

  #refresh(entry: PermissionEntry): void {
    if (entry.phase !== 'available') return;
    try {
      if (!this.#isRunLive(entry.permission) || entry.isRunLive?.(entry.permission.runId) === false) this.#expire(entry);
    } catch { this.#expire(entry); }
  }

  #isRunLive(permission: NodePermissionReference): boolean {
    try { return this.#streams.get(producerStreamKey(permission.stream))?.isRunLive(permission.runId) === true; }
    catch { return false; }
  }

  #expire(entry: PermissionEntry): void {
    entry.respond = null;
    entry.isRunLive = null;
    if (entry.phase === 'available') this.#settle(entry, 'expired');
  }

  #settle(entry: PermissionEntry, phase: PermissionReceipt['phase']): void {
    entry.phase = phase;
    entry.respond = null;
    entry.isRunLive = null;
    this.#entries.delete(entry.permission.handle);
    if (this.#closed) return;
    const now = this.options.supervisor.poll();
    if (!Number.isFinite(now) || this.options.signal.aborted) { this.close(); return; }
    this.#receipts.set(entry.permission.handle, { permission: entry.permission, phase, fingerprint: entry.fingerprint, expiresAt: now + this.#receiptMs });
    while (this.#receipts.size > this.#maxReceipts) this.#forget(this.#receipts.keys().next().value!);
  }

  #forget(handle: string): void {
    const receipt = this.#receipts.get(handle);
    if (receipt) this.#occurrences.delete(receipt.permission.permissionOccurrenceId);
    this.#receipts.delete(handle);
  }

  #poll(): number {
    const now = this.options.supervisor.poll();
    if (!Number.isFinite(now) || this.options.signal.aborted) this.close();
    if (this.#closed) throw expired();
    for (const [handle, receipt] of this.#receipts) {
      if (receipt.expiresAt > now) break;
      this.#forget(handle);
    }
    for (const [handle, expiresAt] of this.#minted) {
      if (expiresAt > now) break;
      this.#minted.delete(handle);
    }
    for (const entry of this.#entries.values()) this.#refresh(entry);
    return now;
  }
}

function samePermission(left: NodePermissionReference, right: NodePermissionReference): boolean {
  return producerStreamKey(left.stream) === producerStreamKey(right.stream) && left.handle === right.handle
    && left.runId === right.runId && left.permissionOccurrenceId === right.permissionOccurrenceId;
}

function snapshot(entry: Pick<PermissionEntry, 'permission' | 'phase'>): NodePermissionResult {
  return { kind: 'permission', receipt: { permission: entry.permission, phase: entry.phase } };
}

function expired(): NodeAuthorityError { return new NodeAuthorityError('NODE_SESSION_EXPIRED', 'Permission authority is retired or replaced'); }
function capacity(): DomainError { return new DomainError('NODE_CAPACITY', 'Permission registry capacity exceeded', 429); }

function awaitResponse(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
