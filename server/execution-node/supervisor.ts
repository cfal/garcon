import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isExecutionIdentity, type ExecutionNodeStatus } from '../../common/execution-location.js';
import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import { SuspendAwareLeaseClock, type LeaseClock } from './lease-clock.js';

export const NODE_CHALLENGE_INTERVAL_MS = 5_000;
export const NODE_SESSION_LEASE_POLL_INTERVAL_MS = 100;
export const NODE_CONTROLLER_LEASE_MS = 15_000;
export const NODE_RECOVERY_TIMEOUT_MS = 15_000;
export const NODE_CLEANUP_TIMEOUT_MS = 30_000;

export type NodeRetirementReason =
  | 'lease-expired' | 'recovery-expired' | 'clock-discontinuity' | 'worker-exited' | 'worker-protocol-failed'
  | 'native-settlement-unconfirmed' | 'revoked' | 'controller-shutdown' | 'node-shutdown';

const RETIREMENT_PRIORITY: Record<NodeRetirementReason, number> = {
  'lease-expired': 0, 'recovery-expired': 1, 'clock-discontinuity': 2,
  'worker-exited': 3, 'worker-protocol-failed': 4, 'native-settlement-unconfirmed': 5, revoked: 6, 'controller-shutdown': 7, 'node-shutdown': 8,
};

export interface NodeConnectionLease {
  readonly session: NodeSessionIdentity;
  /** Ends on physical disconnect or replacement, independently of admitted work. */
  readonly signal: AbortSignal;
  /** Ends only when logical execution authority retires. */
  readonly authoritySignal: AbortSignal;
}

export interface NodeRecoveryAttempt {
  readonly token: symbol;
}

export interface NodeCleanupFailure {
  readonly code: 'NODE_CLEANUP_FAILED' | 'NODE_CLEANUP_REENTRANT';
  readonly message: string;
}

export interface NodeSupervisorOptions {
  readonly clock?: LeaseClock;
  readonly scheduleTimeout?: (callback: () => void, delay: number) => { cancel(): void };
  /**
   * Confirms all session-owned workers/PTYs stopped; cannot call cleanup controls while its attempt remains in flight.
   * The reason is best-effort: an in-flight success may omit a promoted reason. Node-lifetime teardown must not depend on it.
   */
  cleanup(session: NodeSessionIdentity, reason: NodeRetirementReason): Promise<void>;
}

export class NodeAuthorityError extends Error {
  constructor(readonly code: 'NODE_UNAVAILABLE' | 'NODE_SESSION_EXPIRED', message: string) {
    super(message);
    this.name = 'NodeAuthorityError';
  }
}

interface ActiveControllerSession {
  readonly identity: NodeSessionIdentity;
  readonly controller: AbortController;
  connection: { readonly lease: NodeConnectionLease; readonly controller: AbortController } | null;
  phase: 'online' | 'recovering' | 'reconnecting';
  recovery: NodeRecoveryAttempt | null;
  recoveryDeadline: number | null;
  deadline: number;
  lastChallengeAt: number;
  readonly challenges: Map<string, number>;
}

interface RetiredControllerSession {
  readonly identity: NodeSessionIdentity;
  readonly connection: NodeConnectionLease | null;
  reason: NodeRetirementReason;
}

/** Owns remote authority; the connection driver polls it and supplies verified process/PTY cleanup. */
export class NodeSupervisor {
  readonly #nodeBootId = randomUUID();
  readonly #clock: LeaseClock;
  #active: ActiveControllerSession | null = null;
  #retired: RetiredControllerSession | null = null;
  #cleanup: { readonly token: symbol; readonly result: Promise<boolean>; reentered: boolean } | null = null;
  readonly #cleanupContext = new AsyncLocalStorage<symbol>();
  #cleanupFailure: NodeCleanupFailure | null = null;
  #closed = false;

  constructor(private readonly options: NodeSupervisorOptions) {
    this.#clock = options.clock ?? new SuspendAwareLeaseClock();
  }

  /** Observing availability also expires overdue authority and starts its cleanup. */
  get status(): ExecutionNodeStatus {
    this.poll();
    return this.#retired ? 'cleaning-up' : this.#active?.phase ?? 'offline';
  }

  get retirementReason(): NodeRetirementReason | null { return this.#retired?.reason ?? null; }

  get cleanupFailure(): NodeCleanupFailure | null {
    return this.#cleanupFailure;
  }

  openSession(controllerBootId: string): NodeSessionIdentity {
    if (!isExecutionIdentity(controllerBootId)) throw new TypeError('Invalid controller boot identity');
    const now = this.poll();
    if (this.#closed) throw new NodeAuthorityError('NODE_UNAVAILABLE', 'The node supervisor is shut down');
    if (this.#active) throw new NodeAuthorityError('NODE_UNAVAILABLE', 'Another controller execution session is still authoritative');
    if (this.#retired) {
      throw new NodeAuthorityError('NODE_UNAVAILABLE', 'A fresh controller session requires completed cleanup');
    }
    if (!Number.isFinite(now)) throw new NodeAuthorityError('NODE_UNAVAILABLE', 'The node lease clock is unavailable');
    const identity = Object.freeze({ controllerBootId, nodeBootId: this.#nodeBootId, logicalSessionId: randomUUID() });
    this.#active = {
      identity, controller: new AbortController(), connection: null, phase: 'recovering',
      recovery: null, recoveryDeadline: now + NODE_RECOVERY_TIMEOUT_MS,
      deadline: now + NODE_CONTROLLER_LEASE_MS, lastChallengeAt: -Infinity, challenges: new Map(),
    };
    return identity;
  }

  attach(identity: NodeSessionIdentity): NodeConnectionLease {
    const now = this.poll();
    const active = this.#active;
    if (!active || !sameNodeSession(identity, active.identity)) throw expired();
    const previous = active.connection;
    const controller = new AbortController();
    const connection = Object.freeze({
      session: active.identity, signal: controller.signal, authoritySignal: active.controller.signal,
    });
    active.connection = { lease: connection, controller };
    active.phase = 'recovering';
    active.recovery = null;
    active.recoveryDeadline ??= now + NODE_RECOVERY_TIMEOUT_MS;
    active.challenges.clear();
    active.lastChallengeAt = -Infinity;
    previous?.controller.abort(expired());
    return connection;
  }

  disconnect(connection: NodeConnectionLease): void {
    const now = this.poll();
    const active = this.#active;
    if (!active || active.connection?.lease !== connection) return;
    const detached = active.connection;
    active.connection = null;
    active.challenges.clear();
    active.phase = 'reconnecting';
    active.recovery = null;
    active.recoveryDeadline ??= now + NODE_RECOVERY_TIMEOUT_MS;
    detached.controller.abort(expired());
  }

  beginRecovery(connection: NodeConnectionLease): NodeRecoveryAttempt {
    const { active, now } = this.#requireConnection(connection);
    active.phase = 'recovering';
    active.recoveryDeadline ??= now + NODE_RECOVERY_TIMEOUT_MS;
    active.recovery = Object.freeze({ token: Symbol('node-recovery') });
    return active.recovery;
  }

  completeRecovery(connection: NodeConnectionLease, attempt: NodeRecoveryAttempt): boolean {
    const { active } = this.#requireConnection(connection);
    if (active.phase !== 'recovering' || active.recovery === null || active.recovery !== attempt) return false;
    active.phase = 'online';
    active.recovery = null;
    active.recoveryDeadline = null;
    return true;
  }

  assertAdmission(connection: NodeConnectionLease): void {
    const { active } = this.#requireConnection(connection);
    if (active.phase !== 'online') {
      throw new NodeAuthorityError('NODE_UNAVAILABLE', 'Node output and live controls are still recovering');
    }
  }

  /** Allows exact-session reconciliation while new admissions remain suspended. */
  assertConnection(connection: NodeConnectionLease): void {
    this.#requireConnection(connection);
  }

  issueChallenge(connection: NodeConnectionLease): string | null {
    const { active, now } = this.#requireConnection(connection);
    if (now - active.lastChallengeAt < NODE_CHALLENGE_INTERVAL_MS) return null;
    active.lastChallengeAt = now;
    for (const [challenge, expiresAt] of active.challenges) if (now >= expiresAt) active.challenges.delete(challenge);
    const challenge = randomUUID();
    active.challenges.set(challenge, now + NODE_CONTROLLER_LEASE_MS);
    return challenge;
  }

  renew(connection: NodeConnectionLease, challenge: string): boolean {
    const now = this.poll();
    const active = this.#active;
    if (!active || active.connection?.lease !== connection) return false;
    const expiresAt = active.challenges.get(challenge);
    if (expiresAt === undefined) return false;
    active.challenges.delete(challenge);
    if (now >= expiresAt) return false;
    active.deadline = now + NODE_CONTROLLER_LEASE_MS;
    return true;
  }

  poll(): number {
    const reading = this.#clock.read();
    if (this.#active) {
      if (reading.discontinuity || !Number.isFinite(reading.elapsedMs) || reading.elapsedMs < 0) this.#retire('clock-discontinuity');
      else if (reading.elapsedMs >= this.#active.deadline) this.#retire('lease-expired');
      else if (this.#active.recoveryDeadline !== null && reading.elapsedMs >= this.#active.recoveryDeadline) {
        this.#retire('recovery-expired');
      }
    }
    // With no old authority, a finite discontinuity establishes the baseline for a fresh session.
    return reading.elapsedMs < 0 ? NaN : reading.elapsedMs;
  }

  /** Performs node-wide administrative revocation, not an authenticated connection callback. */
  revoke(): Promise<boolean> {
    const reentry = this.#rejectCleanupReentry();
    if (reentry) return reentry;
    this.#retire('revoked');
    return this.retryCleanup();
  }

  revokeConnection(connection: NodeConnectionLease): Promise<boolean> {
    return this.#retireConnection(connection, 'revoked');
  }

  controllerShutdown(connection: NodeConnectionLease): Promise<boolean> {
    return this.#retireConnection(connection, 'controller-shutdown');
  }

  executionHostExited(identity: NodeSessionIdentity, cause: 'worker-exited' | 'worker-protocol-failed'): Promise<boolean> {
    return this.#retireSession(identity, cause);
  }

  requestNativeContainment(identity: NodeSessionIdentity): Promise<boolean> {
    return this.#retireSession(identity, 'native-settlement-unconfirmed');
  }

  #retireSession(identity: NodeSessionIdentity, cause: NodeRetirementReason): Promise<boolean> {
    const reentry = this.#rejectCleanupReentry();
    if (reentry) return reentry;
    this.poll();
    const session = parseNodeSessionIdentity(identity);
    const current = this.#active?.identity ?? this.#retired?.identity;
    if (!session || !current || !sameNodeSession(session, current)) return Promise.resolve(false);
    this.#retire(cause);
    return this.retryCleanup();
  }

  retryCleanup(): Promise<boolean> {
    const reentry = this.#rejectCleanupReentry();
    if (reentry) return reentry;
    return this.#cleanup?.result ?? (this.#retired ? this.#startCleanup(this.#retired) : Promise.resolve(true));
  }

  shutdown(): Promise<boolean> {
    const reentry = this.#rejectCleanupReentry();
    if (reentry) return reentry;
    this.#closed = true;
    this.#retire('node-shutdown');
    return this.retryCleanup();
  }

  #requireConnection(connection: NodeConnectionLease): { active: ActiveControllerSession; now: number } {
    const now = this.poll();
    const active = this.#active;
    if (!active || active.connection?.lease !== connection) throw expired();
    return { active, now };
  }

  #retireConnection(connection: NodeConnectionLease, reason: NodeRetirementReason): Promise<boolean> {
    const reentry = this.#rejectCleanupReentry();
    if (reentry) return reentry;
    this.poll();
    if (this.#active?.connection?.lease !== connection && this.#retired?.connection !== connection) {
      return Promise.resolve(false);
    }
    this.#retire(reason);
    return this.retryCleanup();
  }

  #retire(reason: NodeRetirementReason): void {
    const active = this.#active;
    if (!active) {
      if (this.#retired && RETIREMENT_PRIORITY[reason] > RETIREMENT_PRIORITY[this.#retired.reason]) {
        this.#retired.reason = reason;
      }
      return;
    }
    this.#active = null;
    const retired = { identity: active.identity, connection: active.connection?.lease ?? null, reason };
    this.#retired = retired;
    this.#startCleanup(retired);
    active.controller.abort(expired());
    active.connection?.controller.abort(expired());
  }

  #startCleanup(retired: RetiredControllerSession): Promise<boolean> {
    const token = Symbol('node-cleanup');
    const reason = retired.reason;
    const deadline = Promise.withResolvers<boolean>();
    let settled = false;
    const timeout = (this.options.scheduleTimeout ?? scheduleTimeout)(() => {
      if (settled) return;
      if (this.#retired === retired) this.#cleanupFailure = Object.freeze({
        code: 'NODE_CLEANUP_FAILED',
        message: 'Provider and terminal cleanup timed out; replacement admission remains fenced until cleanup settles.',
      });
      deadline.resolve(false);
    }, NODE_CLEANUP_TIMEOUT_MS);
    const finishAttempt = () => {
      settled = true;
      timeout.cancel();
      if (this.#cleanup === cleanup) this.#cleanup = null;
    };
    const failAttempt = (error: unknown) => {
      finishAttempt();
      if (this.#retired === retired) this.#cleanupFailure = Object.freeze(error instanceof CleanupReentryError
        ? { code: 'NODE_CLEANUP_REENTRANT', message: error.message }
        : { code: 'NODE_CLEANUP_FAILED', message: 'Provider and terminal cleanup could not be confirmed; retry cleanup before admitting a new session.' });
      return false;
    };
    const completion = Promise.resolve().then(() => this.#cleanupContext.run(token,
      () => this.options.cleanup(retired.identity, reason),
    )).then(
      () => {
        if (cleanup.reentered) return failAttempt(new CleanupReentryError());
        finishAttempt();
        if (this.#retired === retired) {
          this.#retired = null;
          this.#cleanupFailure = null;
        }
        return true;
      },
      failAttempt,
    );
    // A timed-out wait never authorizes concurrent cleanup or a replacement incarnation.
    const cleanup = { token, result: Promise.race([completion, deadline.promise]), reentered: false };
    this.#cleanup = cleanup;
    return cleanup.result;
  }

  #rejectCleanupReentry(): Promise<never> | null {
    if (!this.#cleanup || this.#cleanupContext.getStore() !== this.#cleanup.token) return null;
    this.#cleanup.reentered = true;
    const rejected = Promise.reject<never>(new CleanupReentryError());
    // The attempt reports the failure even when a callback discards this rejected result.
    void rejected.catch(() => {});
    return rejected;
  }
}

function scheduleTimeout(callback: () => void, delay: number): { cancel(): void } {
  const timeout = setTimeout(callback, delay);
  return { cancel: () => clearTimeout(timeout) };
}

class CleanupReentryError extends Error {
  constructor() {
    super('The cleanup callback must not re-enter supervisor cleanup controls');
    this.name = 'CleanupReentryError';
  }
}

function expired(): NodeAuthorityError {
  return new NodeAuthorityError('NODE_SESSION_EXPIRED', 'The controller execution session is no longer authoritative');
}
