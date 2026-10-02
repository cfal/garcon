import type { OutstandingCall, OutstandingCallState } from './rpc-protocol.js';
import type { RpcLane } from './rpc-lane.js';
import { BULK_JOURNAL_BYTES, RPC_JOURNAL_BYTES } from './limits.js';
import { RpcAdmission } from './rpc-admission.js';

// Bounds worker memory for replies awaiting acknowledgement across sessions.
// Receipt records of recent sessions, so a reconcile interrupted by another
// loss can still prove which requests never arrived.
const RECEIPT_SESSIONS = 16;
const DELIVERY_RETRY_MS = 10;

// The session that delivers a journaled reply. `offer` returns false when the
// session cannot take the reply now; the journal offers it again as it drains.
export interface RpcJournalOwner {
  readonly lane: RpcLane;
  readonly session: string;
  offer(payload: string): boolean;
}

export interface JournaledCall {
  readonly id: string;
  readonly signal: AbortSignal;
}

interface JournalEntry extends JournaledCall {
  readonly lane: RpcLane;
  readonly controller: AbortController;
  // Null once its session is lost, until a replacement claims the call.
  owner: RpcJournalOwner | null;
  // Null while the handler runs.
  reply: string | null;
  // A small unknown outcome that replaces a reply dropped under pressure.
  undeliverable: string | null;
  bytes: number;
  delivered: boolean;
  cancelled: boolean;
}

export interface RpcReplyJournalOptions {
  readonly retainedBytes?: number;
  readonly bulkRetainedBytes?: number;
}

// Keeps a worker's journaled calls across controller sessions: the reply half
// of VS Code's persistent protocol, which keeps every unacknowledged message
// and sends it again after a reconnect (https://github.com/microsoft/vscode/blob/f39c7109bf651845855cbef5af2e91b2c9bd0a74/src/vs/base/parts/ipc/common/ipc.net.ts#L974-L989).
// A call is registered before its handler runs and keeps running when its
// session is lost. Its reply stays until the controller acknowledges it, and a
// replacement session claims the calls its controller still waits for. Under
// memory pressure the oldest replies are dropped, and their calls reconcile as
// unknown.
export class RpcReplyJournal {
  readonly admission = new RpcAdmission();
  readonly #entries = new Map<string, JournalEntry>();
  readonly #received = new Map<string, { lane: RpcLane; seq: number }>();
  readonly #retainedLimit: number;
  readonly #bulkRetainedLimit: number;
  #retainedBytes = 0;
  #bulkRetainedBytes = 0;
  #running = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RpcReplyJournalOptions = {}) {
    this.#retainedLimit = options.retainedBytes ?? RPC_JOURNAL_BYTES;
    this.#bulkRetainedLimit = options.bulkRetainedBytes ?? Math.min(BULK_JOURNAL_BYTES, Math.floor(this.#retainedLimit * 3 / 4));
  }

  get running(): number { return this.#running; }

  // Calls running or awaiting acknowledgement.
  get size(): number { return this.#entries.size; }

  has(id: string): boolean { return this.#entries.has(id); }

  // Requests arrive in order, so the latest sequence covers every earlier one.
  received(owner: RpcJournalOwner, seq: number): void {
    const prior = this.#received.get(owner.session);
    if (prior && prior.lane !== owner.lane) throw new Error('RPC receipt lane mismatch');
    this.#received.delete(owner.session);
    this.#received.set(owner.session, { lane: owner.lane, seq });
    const sessions = [...this.#received].filter(([, receipt]) => receipt.lane === owner.lane);
    if (sessions.length > RECEIPT_SESSIONS) this.#received.delete(sessions[0]![0]);
  }

  begin(owner: RpcJournalOwner, id: string): JournaledCall {
    const controller = new AbortController();
    const entry: JournalEntry = {
      id, lane: owner.lane, controller, signal: controller.signal, owner, reply: null, undeliverable: null, bytes: 0, delivered: false, cancelled: false,
    };
    this.#entries.set(id, entry);
    this.#running += 1;
    return entry;
  }

  complete(call: JournaledCall, reply: string, undeliverable: string): void {
    this.#running -= 1;
    const entry = call as JournalEntry;
    if (this.#entries.get(entry.id) !== entry) return;
    if (entry.cancelled) {
      this.#entries.delete(entry.id);
      return;
    }
    entry.reply = reply;
    entry.undeliverable = undeliverable;
    entry.bytes = Buffer.byteLength(reply);
    this.#retainedBytes += entry.bytes;
    if (entry.lane === 'bulk') this.#bulkRetainedBytes += entry.bytes;
    this.#evict(entry.lane);
    this.deliver();
  }

  // The caller gave up: its handler is aborted and any reply dropped.
  cancel(owner: RpcJournalOwner, id: string): void {
    const entry = this.#entries.get(id);
    if (entry?.owner === owner) this.#discard(entry);
  }

  acknowledge(owner: RpcJournalOwner, ids: readonly string[]): void {
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (entry?.owner === owner && entry.reply !== null) this.#forget(entry);
    }
  }

  // A reply offered to a lost session may not have arrived, so a replacement
  // that claims the call receives it again.
  ownerLost(owner: RpcJournalOwner): void {
    for (const entry of this.#entries.values()) {
      if (entry.owner !== owner) continue;
      entry.owner = null;
      entry.delivered = false;
    }
  }

  // Claims for `owner` the calls its controller still waits for. Calls of lost
  // sessions it does not name belong to callers that gave up, so they are
  // cancelled as those callers' lost cancels would have.
  reconcile(owner: RpcJournalOwner, calls: readonly OutstandingCall[]): OutstandingCallState[] {
    const ids = new Set<string>();
    for (const call of calls) {
      const entry = this.#entries.get(call.id);
      const receipt = this.#received.get(call.session);
      if (ids.has(call.id) || entry && (entry.lane !== owner.lane || entry.owner !== null && entry.owner !== owner)
        || receipt && receipt.lane !== owner.lane) throw new Error('RPC reconciliation ownership mismatch');
      ids.add(call.id);
    }
    const claimed = new Set<JournalEntry>();
    const states = calls.map(({ id, session, seq }): OutstandingCallState => {
      const entry = this.#entries.get(id);
      if (entry && !entry.cancelled) {
        entry.owner = owner;
        entry.delivered = false;
        claimed.add(entry);
        return { id, state: 'pending' };
      }
      const received = this.#received.get(session);
      return { id, state: received !== undefined && seq > received.seq ? 'not-received' : 'unknown' };
    });
    for (const entry of [...this.#entries.values()]) {
      if (entry.lane === owner.lane && entry.owner === null && !claimed.has(entry)) this.#discard(entry);
    }
    return states;
  }

  // Offers completed replies to the sessions that own them.
  deliver(): void {
    const blocked = new Set<RpcLane>();
    for (const entry of [...this.#entries.values()]) {
      if (entry.reply === null || entry.delivered || !entry.owner || blocked.has(entry.lane)) continue;
      if (!entry.owner.offer(entry.reply)) {
        this.#retry ??= setTimeout(() => { this.#retry = null; this.deliver(); }, DELIVERY_RETRY_MS);
        this.#retry.unref?.();
        blocked.add(entry.lane);
        continue;
      }
      entry.delivered = true;
    }
  }

  dispose(): void {
    for (const entry of this.#entries.values()) entry.controller.abort();
    this.#entries.clear();
    this.#received.clear();
    this.#retainedBytes = 0;
    this.#bulkRetainedBytes = 0;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
  }

  // Drops the oldest replies, delivered ones first, until retention fits. A
  // session still waiting for an undelivered reply gets an unknown outcome in
  // its place, so its caller does not wait out its deadline.
  #evict(lane: RpcLane): void {
    this.#evictReplies('bulk', () => this.#bulkRetainedBytes > this.#bulkRetainedLimit);
    this.#evictReplies(lane === 'bulk' ? 'bulk' : null, () => this.#retainedBytes > this.#retainedLimit);
  }

  #evictReplies(lane: RpcLane | null, overLimit: () => boolean): void {
    for (const delivered of [true, false]) {
      for (const entry of [...this.#entries.values()]) {
        if (!overLimit()) return;
        if (lane !== null && entry.lane !== lane) continue;
        if (entry.reply === null || entry.delivered !== delivered || entry.reply === entry.undeliverable) continue;
        if (delivered || !entry.owner || entry.undeliverable === null) this.#forget(entry);
        else this.#replaceReply(entry, entry.undeliverable);
      }
    }
    // Even unknown-outcome placeholders must fit the retained byte budget.
    for (const entry of [...this.#entries.values()]) {
      if (!overLimit()) return;
      if (entry.reply !== null && (lane === null || entry.lane === lane)) this.#forget(entry);
    }
  }

  #replaceReply(entry: JournalEntry, reply: string): void {
    const bytes = Buffer.byteLength(reply);
    this.#retainedBytes += bytes - entry.bytes;
    if (entry.lane === 'bulk') this.#bulkRetainedBytes += bytes - entry.bytes;
    entry.reply = reply;
    entry.bytes = bytes;
  }

  #discard(entry: JournalEntry): void {
    entry.cancelled = true;
    entry.controller.abort();
    if (entry.reply !== null) this.#forget(entry);
  }

  #forget(entry: JournalEntry): void {
    this.#entries.delete(entry.id);
    if (entry.reply !== null) {
      this.#retainedBytes -= entry.bytes;
      if (entry.lane === 'bulk') this.#bulkRetainedBytes -= entry.bytes;
    }
  }
}
