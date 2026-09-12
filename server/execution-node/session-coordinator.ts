import { sameNodeSession, type NodeSessionIdentity } from '../../common/node-operation.js';
import type { NodeProviderManifest } from '../execution-nodes/provider-manifest.js';
import { NodeOutputRetirementRelay } from './output-retirement-relay.js';
import { NodeSessionLeaseMonitor } from './session-lease-monitor.js';
import { NodeAuthorityError, NodeSupervisor, type NodeConnectionLease, type NodeRecoveryAttempt, type NodeSupervisorOptions } from './supervisor.js';
import { NodeSessionHostOwner, type NodeSessionHost, type NodeSessionHostOptions } from './systemd/session-host.js';
import { parseNodeWorkerConfiguration, type NodeSessionWorkerConfiguration } from './worker/configuration.js';
import type { NodeWorkerPeer, NodeWorkerPeerOptions } from './worker/peer.js';
import type { NodeWorkerOutputRetirement } from './worker/output-retirement.js';

type CoordinatorPeer = Pick<NodeWorkerPeer, 'hello' | 'configure' | 'attach' | 'admit' | 'disconnect' | 'closeInput'
  | 'execution' | 'service' | 'forward' | 'waitForRelease'>;

export interface NodeHostedConnection {
  readonly connectionId: number;
  readonly lease: NodeConnectionLease;
  readonly ready: Promise<readonly NodeProviderManifest[]>;
}

interface HostedAuthority {
  readonly session: NodeSessionIdentity;
  readonly signal: AbortSignal;
  readonly settled: PromiseWithResolvers<void>;
  readonly ready: PromiseWithResolvers<readonly NodeProviderManifest[]>;
  host: NodeSessionHost | null;
  peer: CoordinatorPeer | null;
  monitor: NodeSessionLeaseMonitor | null;
  retirements: NodeOutputRetirementRelay | null;
  connection: NodeHostedConnection;
  recovery: HostedRecovery | null;
}

interface HostedRecovery {
  readonly attempt: NodeRecoveryAttempt;
  completion: Promise<boolean> | null;
}

export interface NodeSessionCoordinatorOptions {
  readonly configuration: NodeSessionWorkerConfiguration;
  readonly host: Omit<NodeSessionHostOptions, 'exited'>;
  readonly supervisor?: Omit<NodeSupervisorOptions, 'cleanup'>;
  readonly scheduleLeasePoll?: (callback: () => void, delayMs: number) => { cancel(): void };
  createPeer(host: NodeSessionHost, options: NodeWorkerPeerOptions): CoordinatorPeer;
  received: NonNullable<NodeWorkerPeerOptions['received']>;
}

/** Composes logical authority with an inert, containment-confirmed worker tree outside that tree's lifetime. */
export class NodeSessionCoordinator {
  readonly supervisor: NodeSupervisor;
  readonly #owner: NodeSessionHostOwner;
  readonly #configuration: NodeSessionWorkerConfiguration;
  #current: HostedAuthority | null = null;
  #initialized = false;
  #initializing: Promise<void> | null = null;
  #attaching = false;
  #closed = false;

  constructor(private readonly options: NodeSessionCoordinatorOptions) {
    const configuration = parseNodeWorkerConfiguration(options.configuration);
    if (configuration?.role !== 'session' || options.host.nodeId !== configuration.nodeId) throw unavailable();
    this.#configuration = configuration;
    this.supervisor = new NodeSupervisor({ ...options.supervisor, cleanup: (session) => this.#cleanup(session) });
    this.#owner = new NodeSessionHostOwner({ ...options.host,
      exited: (session) => { void this.supervisor.executionHostExited(session, 'worker-exited'); } });
  }

  initialize(): Promise<void> {
    if (this.#closed) return Promise.reject(unavailable());
    return this.#initializeOwner();
  }

  #initializeOwner(): Promise<void> {
    if (this.#initialized) return Promise.resolve();
    if (this.#initializing) return this.#initializing;
    return this.#initializing = this.#owner.reconcile().then(() => {
      this.#initialized = true;
    }).finally(() => { this.#initializing = null; });
  }

  /** Returns lease authority before worker readiness so authenticated heartbeats cover startup too. */
  open(controllerBootId: string): NodeHostedConnection {
    if (this.#closed || !this.#initialized || this.#current) throw unavailable();
    const session = this.supervisor.openSession(controllerBootId);
    const lease = this.supervisor.attach(session);
    const ready = Promise.withResolvers<readonly NodeProviderManifest[]>();
    const connected = ready.promise.then((manifests) => { this.#requireConnection(connection); return manifests; });
    void connected.catch(() => {});
    const connection: NodeHostedConnection = Object.freeze({ connectionId: 1, lease, ready: connected });
    const current: HostedAuthority = { session, signal: lease.authoritySignal, ready, connection,
      settled: Promise.withResolvers<void>(), host: null, peer: null, monitor: null, retirements: null, recovery: null };
    this.#current = current;
    void ready.promise.catch(() => {});
    current.monitor = new NodeSessionLeaseMonitor({ supervisor: this.supervisor, authoritySignal: current.signal,
      schedulePoll: this.options.scheduleLeasePoll,
      failed: () => { void this.supervisor.executionHostExited(session, 'worker-protocol-failed'); } });
    void this.#start(current).then(ready.resolve, (error) => {
      ready.reject(error);
      void this.supervisor.executionHostExited(session, 'worker-protocol-failed');
    }).finally(current.settled.resolve);
    return connection;
  }

  attach(session: NodeSessionIdentity): NodeHostedConnection {
    const current = this.#current;
    if (this.#closed || this.#attaching || !current || !sameNodeSession(current.session, session)) throw unavailable();
    this.#attaching = true;
    try {
      const connectionId = current.connection.connectionId + 1;
      if (!Number.isSafeInteger(connectionId)) {
        void this.supervisor.executionHostExited(session, 'worker-protocol-failed');
        throw unavailable();
      }
      const lease = this.supervisor.attach(session);
      this.supervisor.assertConnection(lease);
      this.#assertAuthority(current);
      const ready = current.ready.promise.then(async (manifests) => {
        this.#requireConnection(connection);
        await current.peer!.attach(connectionId);
        this.#requireConnection(connection);
        return manifests;
      });
      void ready.catch(() => {});
      const connection: NodeHostedConnection = Object.freeze({ connectionId, lease, ready });
      current.connection = connection;
      current.recovery = null;
      return connection;
    } finally {
      this.#attaching = false;
    }
  }

  async disconnect(connection: NodeHostedConnection): Promise<void> {
    const current = this.#current;
    if (!current || current.connection !== connection) return;
    current.recovery = null;
    this.supervisor.disconnect(connection.lease);
    // Startup may still be inert; its readiness continuation applies the disconnected gate.
    if (current.peer) await current.peer.disconnect(connection.connectionId);
  }

  peer(connection: NodeHostedConnection): CoordinatorPeer {
    const current = this.#requireConnection(connection);
    if (!current.peer) throw unavailable();
    return current.peer;
  }

  retireOutput(connection: NodeHostedConnection, frame: NodeWorkerOutputRetirement): void {
    const current = this.#requireConnection(connection);
    if (!current.retirements) throw unavailable();
    current.retirements.enqueue(frame);
  }

  async flushOutputRetirements(connection: NodeHostedConnection): Promise<void> {
    const current = this.#requireConnection(connection);
    if (!current.retirements) throw unavailable();
    await current.retirements.flush();
    this.#requireConnection(connection);
  }

  beginRecovery(connection: NodeHostedConnection): NodeRecoveryAttempt {
    const current = this.#requireConnection(connection);
    const attempt = this.supervisor.beginRecovery(connection.lease);
    current.recovery = { attempt, completion: null };
    return attempt;
  }

  async completeRecovery(connection: NodeHostedConnection, attempt: NodeRecoveryAttempt): Promise<boolean> {
    const current = this.#requireConnection(connection);
    const recovery = current.recovery;
    if (!recovery || recovery.attempt !== attempt) return false;
    return recovery.completion ??= this.#completeRecovery(connection, current, recovery);
  }

  async #completeRecovery(connection: NodeHostedConnection, current: HostedAuthority, recovery: HostedRecovery): Promise<boolean> {
    await connection.ready;
    this.#requireConnection(connection);
    if (current.recovery !== recovery) return false;
    await current.peer!.admit(connection.connectionId);
    this.#requireConnection(connection);
    if (current.recovery !== recovery) return false;
    const admitted = this.supervisor.completeRecovery(connection.lease, recovery.attempt);
    if (admitted) current.recovery = null;
    return admitted;
  }

  async shutdown(): Promise<boolean> {
    this.#closed = true;
    const cleanup = this.supervisor.shutdown();
    try { await this.#initializeOwner(); }
    catch { return false; }
    return cleanup;
  }

  async #start(current: HostedAuthority): Promise<readonly NodeProviderManifest[]> {
    this.#assertAuthority(current);
    const host = await this.#owner.launch();
    current.host = host;
    this.#assertAuthority(current);
    const peer = this.options.createPeer(host, { role: 'session', signal: current.signal,
      validate: () => this.#assertAuthority(current), received: this.options.received,
      failed: () => { void this.supervisor.executionHostExited(current.session, 'worker-protocol-failed'); } });
    current.peer = peer;
    const pid = await peer.hello;
    this.#assertAuthority(current);
    const identity = await this.#owner.confirm(host);
    this.#assertAuthority(current);
    if (pid !== identity.mainPid) throw unavailable();
    this.#owner.bind(host, current.session);
    const manifests = await peer.configure(current.session, 1, this.#configuration);
    this.#assertAuthority(current);
    current.retirements = new NodeOutputRetirementRelay({ session: current.session,
      instanceIds: new Set(this.#configuration.instances.map((instance) => instance.id)), signal: current.signal, peer,
      failed: () => { void this.supervisor.executionHostExited(current.session, 'worker-protocol-failed'); } });
    if (current.connection.lease.signal.aborted) await peer.disconnect(1);
    return manifests;
  }

  async #cleanup(session: NodeSessionIdentity): Promise<void> {
    const current = this.#current;
    if (!current) { await this.#owner.reconcile(); return; }
    if (!sameNodeSession(current.session, session)) throw unavailable();
    current.peer?.closeInput();
    await current.settled.promise;
    // A failed launch can leave only its pre-spawn marker; both paths require verified containment cleanup.
    if (current.host) await this.#owner.stop(current.host);
    else await this.#owner.reconcile();
    current.monitor?.close();
    if (this.#current === current) this.#current = null;
  }

  #requireConnection(connection: NodeHostedConnection): HostedAuthority {
    const current = this.#current;
    if (!current || current.connection !== connection) throw unavailable();
    this.supervisor.assertConnection(connection.lease);
    this.#assertAuthority(current);
    return current;
  }

  #assertAuthority(current: HostedAuthority): void {
    this.supervisor.poll();
    if (this.#current !== current) throw unavailable();
    current.signal.throwIfAborted();
  }
}

function unavailable(): NodeAuthorityError { return new NodeAuthorityError('NODE_UNAVAILABLE', 'Execution worker authority is unavailable'); }
