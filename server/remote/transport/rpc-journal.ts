import type { OutstandingCall, OutstandingCallState } from './rpc-protocol.js';

// Bounds worker memory for replies awaiting acknowledgement across sessions.
const RETAINED_REPLY_BYTES = 64 * 1024 * 1024;
// Receipt records of recent sessions, so a reconcile interrupted by another
// loss can still prove which requests never arrived.
const RECEIPT_SESSIONS = 16;
const DELIVERY_RETRY_MS = 10;

// The session that delivers a journaled reply. `offer` returns false when the
// session cannot take the reply now; the journal offers it again as it drains.
export interface RpcJournalOwner {
  readonly session: string;
  offer(payload: string): boolean;
}

export interface JournaledCall {
  readonly id: string;
  readonly signal: AbortSignal;
}

interface JournalEntry extends JournaledCall {
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
  readonly #entries = new Map<string, JournalEntry>();
  readonly #received = new Map<string, number>();
  readonly #retainedLimit: number;
  #retainedBytes = 0;
  #running = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RpcReplyJournalOptions = {}) {
    this.#retainedLimit = options.retainedBytes ?? RETAINED_REPLY_BYTES;
  }

  get running(): number { return this.#running; }

  // Calls running or awaiting acknowledgement.
  get size(): number { return this.#entries.size; }

  has(id: string): boolean { return this.#entries.has(id); }

  // Requests arrive in order, so the latest sequence covers every earlier one.
  received(session: string, seq: number): void {
    this.#received.delete(session);
    this.#received.set(session, seq);
    if (this.#received.size > RECEIPT_SESSIONS) this.#received.delete(this.#received.keys().next().value!);
  }

  begin(owner: RpcJournalOwner, id: string): JournaledCall {
    const controller = new AbortController();
    const entry: JournalEntry = {
      id, controller, signal: controller.signal, owner, reply: null, undeliverable: null, bytes: 0, delivered: false, cancelled: false,
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
    this.#evict();
    this.deliver();
  }

  // The caller gave up: its handler is aborted and any reply dropped.
  cancel(id: string): void {
    const entry = this.#entries.get(id);
    if (entry) this.#discard(entry);
  }

  acknowledge(ids: readonly string[]): void {
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (entry && entry.reply !== null) this.#forget(entry);
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
      return { id, state: received !== undefined && seq > received ? 'not-received' : 'unknown' };
    });
    for (const entry of [...this.#entries.values()]) {
      if (entry.owner === null && !claimed.has(entry)) this.#discard(entry);
    }
    return states;
  }

  // Offers completed replies to the sessions that own them.
  deliver(): void {
    for (const entry of [...this.#entries.values()]) {
      if (entry.reply === null || entry.delivered || !entry.owner) continue;
      if (!entry.owner.offer(entry.reply)) {
        this.#retry ??= setTimeout(() => { this.#retry = null; this.deliver(); }, DELIVERY_RETRY_MS);
        this.#retry.unref?.();
        return;
      }
      entry.delivered = true;
    }
  }

  dispose(): void {
    for (const entry of this.#entries.values()) entry.controller.abort();
    this.#entries.clear();
    this.#received.clear();
    this.#retainedBytes = 0;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
  }

  // Drops the oldest replies, delivered ones first, until retention fits. A
  // session still waiting for an undelivered reply gets an unknown outcome in
  // its place, so its caller does not wait out its deadline.
  #evict(): void {
    for (const delivered of [true, false]) {
      for (const entry of [...this.#entries.values()]) {
        if (this.#retainedBytes <= this.#retainedLimit) return;
        if (entry.reply === null || entry.delivered !== delivered || entry.reply === entry.undeliverable) continue;
        if (delivered || !entry.owner || entry.undeliverable === null) this.#forget(entry);
        else this.#replaceReply(entry, entry.undeliverable);
      }
    }
  }

  #replaceReply(entry: JournalEntry, reply: string): void {
    const bytes = Buffer.byteLength(reply);
    this.#retainedBytes += bytes - entry.bytes;
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
    if (entry.reply !== null) this.#retainedBytes -= entry.bytes;
  }
}
