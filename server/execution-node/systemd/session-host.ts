import { parseNodeSessionIdentity, sameNodeSession, type NodeSessionIdentity } from '../../../common/node-operation.js';
import { runSystemdHelper } from './helper-process.js';
import { systemdExecutionLaunch, type SystemdExecutionLaunch, type SystemdExecutionLaunchOptions } from './launch.js';
import { SystemdContainmentError, type SystemdUnitIdentity } from './contracts.js';
import type { NodeSessionMarkerStore } from './session-marker.js';

export interface NodeSessionHostProcess {
  readonly exited: Promise<number>;
  /** Closes the coordinator lifeline; process exit alone remains insufficient cleanup proof. */
  closeInput(): void;
  /** Terminates only this launch's systemd-run waiter; a reaped waiter is a no-op. */
  kill(): void;
}

export interface NodeSessionHost {
  readonly launch: SystemdExecutionLaunch;
  readonly process: NodeSessionHostProcess;
}

export interface NodeSessionHostOptions {
  readonly nodeId: string;
  readonly marker: NodeSessionMarkerStore;
  readonly command: readonly [string, ...string[]];
  readonly launchOptions?: SystemdExecutionLaunchOptions;
  readonly helper?: typeof runSystemdHelper;
  /** Starts an inert worker that cannot create executable resources before confirmation. */
  spawn(launch: SystemdExecutionLaunch): NodeSessionHostProcess;
  exited(session: NodeSessionIdentity): void;
}

interface HostedSession {
  readonly host: NodeSessionHost;
  identity: SystemdUnitIdentity | null;
  confirmed: boolean;
  session: NodeSessionIdentity | null;
  exited: boolean;
  stopping: boolean;
}

/** Keeps cleanup reporting outside the worker unit and admits no replacement without exact cleanup proof. */
export class NodeSessionHostOwner {
  #current: HostedSession | null = null;
  #transition = false;
  #reconciled = false;
  #cleanup: Promise<void> | null = null;

  constructor(private readonly options: NodeSessionHostOptions) {}

  async reconcile(): Promise<void> {
    if (this.#transition || this.#current || this.#cleanup) throw unavailable();
    this.#transition = true;
    this.#reconciled = false;
    try {
      const marker = await this.options.marker.read();
      if (marker) {
        if (marker.identity) await this.#stopIdentity(marker.identity);
        else await this.#retireInert(marker.launch);
        await this.options.marker.clear(marker.launch);
      }
      this.#reconciled = true;
    } finally { this.#transition = false; }
  }

  async launch(): Promise<NodeSessionHost> {
    if (!this.#reconciled || this.#transition || this.#current || this.#cleanup) throw unavailable();
    this.#transition = true;
    try {
      const launch = systemdExecutionLaunch(this.options.nodeId, this.options.command[0], this.options.command.slice(1), this.options.launchOptions);
      await this.options.marker.recordLaunch(launch.identity);
      const process = this.options.spawn(launch);
      const host = Object.freeze({ launch, process });
      const current: HostedSession = { host, identity: null, confirmed: false, session: null, exited: false, stopping: false };
      this.#current = current;
      const exited = () => {
        current.exited = true;
        if (this.#current === current && current.session && !current.stopping) this.options.exited(current.session);
      };
      void process.exited.then(exited, exited).catch(() => {});
      return host;
    } catch (error) {
      this.#reconciled = false;
      throw error;
    } finally { this.#transition = false; }
  }

  /** Follows the worker's inert hello; full identity reaches disk before any configuration or activation. */
  async confirm(host: NodeSessionHost): Promise<SystemdUnitIdentity> {
    const current = this.#require(host);
    if (this.#transition || current.identity || current.exited || current.stopping) throw unavailable();
    this.#transition = true;
    try {
      const identity = await this.#inspect(host.launch.identity);
      // Retains cleanup evidence even when the persistence acknowledgement fails.
      current.identity = identity;
      await this.options.marker.recordIdentity(identity);
      if (current.exited || this.#current !== current) throw unavailable();
      current.confirmed = true;
      return identity;
    } finally { this.#transition = false; }
  }

  bind(host: NodeSessionHost, value: NodeSessionIdentity): void {
    const current = this.#require(host);
    const session = parseNodeSessionIdentity(value);
    if (!session || this.#transition || !current.confirmed || current.session || current.exited || current.stopping) throw unavailable();
    current.session = Object.freeze(session);
  }

  cleanup(session: NodeSessionIdentity): Promise<void> {
    const current = this.#current;
    if (!current?.session || !sameNodeSession(current.session, session)) return Promise.reject(unavailable());
    return this.stop(current.host);
  }

  stop(host: NodeSessionHost): Promise<void> {
    let current: HostedSession;
    try { current = this.#require(host); }
    catch (error) { return Promise.reject(error); }
    if (this.#cleanup) return this.#cleanup;
    if (this.#transition) return Promise.reject(unavailable());
    current.stopping = true;
    this.#cleanup = this.#stop(current).finally(() => { this.#cleanup = null; });
    return this.#cleanup;
  }

  async #stop(current: HostedSession): Promise<void> {
    current.host.process.closeInput();
    if (current.identity) await this.#stopIdentity(current.identity);
    else await this.#retireInert(current.host.launch.identity);
    current.host.process.kill();
    await current.host.process.exited;
    await this.options.marker.clear(current.host.launch.identity);
    if (this.#current === current) this.#current = null;
  }

  async #inspect(launch: SystemdExecutionLaunch['identity']): Promise<SystemdUnitIdentity> {
    const reply = await (this.options.helper ?? runSystemdHelper)({ kind: 'inspect', launch });
    if (reply.kind !== 'ready' || reply.identity.unitName !== launch.unitName || reply.identity.launchId !== launch.launchId) throw unavailable();
    return reply.identity;
  }

  async #stopIdentity(identity: SystemdUnitIdentity): Promise<void> {
    const reply = await (this.options.helper ?? runSystemdHelper)({ kind: 'stop', identity });
    if (reply.kind !== 'stopped') throw unavailable();
  }

  async #retireInert(launch: SystemdExecutionLaunch['identity']): Promise<void> {
    const reply = await (this.options.helper ?? runSystemdHelper)({ kind: 'retire-inert', launch });
    if (reply.kind !== 'retired-inert') throw unavailable();
  }

  #require(host: NodeSessionHost): HostedSession {
    if (!this.#current || this.#current.host !== host) throw unavailable();
    return this.#current;
  }
}

function unavailable(): SystemdContainmentError { return new SystemdContainmentError('NODE_CLEANUP_FAILED'); }
