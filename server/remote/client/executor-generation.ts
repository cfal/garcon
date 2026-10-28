import { rpcWireV1 } from '../transport/rpc-wire-v1.js';
import { RPC_V1, supportedExecutorOperations } from '@garcon/common/executor-contracts';
import { AgentCallError, type ExecutionRuntimeApi, type ExecutorAvailability, type ExecutorCallOptions } from '@garcon/server-agent-interface';
import { parseTicketProjectDefault } from '../../../common/ticket-responses.js';
import { unavailableService } from '../../common/unavailable-service.js';
import { MODEL_DISCOVERY_TIMEOUT_MS } from '../../common/provider-discovery.js';
import type { Logger } from '../../common/log.js';
import { sameContinuity } from '../transport/protocol-compatibility.js';
import { rpcLane } from '../transport/rpc-routing.js';
import type { HeldCallOptions, RemoteSessionBacking, RemoteSessions } from './executor-client.js';
import { RemoteAgentIntegration } from './remote-agent-integration.js';
import { RemoteFilesService } from './remote-files.js';
import { RemoteGitServices } from './remote-git.js';
import { RemoteTerminalService } from './remote-terminals.js';

export class ExecutorGenerationToken {
  #retired = false;
  get retired(): boolean { return this.#retired; }
  retire(): void { this.#retired = true; }
  assertDispatch(): void {
    if (this.#retired) throw staleGeneration();
  }
}

export class RemoteExecutorGeneration {
  readonly token = new ExecutorGenerationToken();
  readonly info;
  readonly manifests;
  readonly continuity;
  readonly profile;
  readonly operations;
  readonly integrations: ReadonlyMap<string, RemoteAgentIntegration>;
  readonly terminals: RemoteTerminalService;
  readonly runtime: ExecutionRuntimeApi;
  readonly #listeners = new Set<(value: ExecutorAvailability) => void>();
  #availability: ExecutorAvailability = 'offline';

  constructor(backing: RemoteSessionBacking, source: Omit<RemoteSessions, 'call'>, dispose: () => Promise<void>, log: Logger) {
    this.info = backing.info;
    this.manifests = backing.manifests;
    this.continuity = backing.continuity;
    this.profile = backing.rpc.transport.profile;
    this.operations = supportedExecutorOperations(this.profile.contracts);
    const assertBacking = (session: RemoteSessionBacking) => {
      this.token.assertDispatch();
      if (session.info.instanceId !== this.info.instanceId || !sameContinuity(session.continuity, this.continuity)) throw staleGeneration();
    };
    const pin = (options: HeldCallOptions) => {
      this.token.assertDispatch();
      if (options.instanceId !== undefined && options.instanceId !== this.info.instanceId) throw staleGeneration();
      return { ...options, instanceId: this.info.instanceId };
    };
    const sessions: RemoteSessions = {
      latest: () => {
        this.token.assertDispatch();
        const session = source.latest();
        assertBacking(session);
        return session;
      },
      acquire: async (lane, options = {}) => {
        const session = await source.acquire(lane, pin(options));
        assertBacking(session.backing);
        return session;
      },
      send: async (lane, options = {}, send) => source.send(lane, pin(options), session => {
        assertBacking(session.backing);
        return send(session);
      }),
      call: async (integrationId, method, request, options = {}) => source.send(rpcLane(method, request), pin(options), ({ backing: held, timeoutMs }) => {
        assertBacking(held);
        return held.rpc.call(integrationId, method, request, { ...options, timeoutMs });
      }),
    };
    this.integrations = new Map([...backing.manifests.values()].map(manifest => [
      manifest.descriptor.id, new RemoteAgentIntegration(manifest, sessions, log),
    ]));
    const files = new RemoteFilesService(sessions);
    const git = new RemoteGitServices(sessions);
    this.terminals = new RemoteTerminalService(sessions);
    const projects = {
      ticketProjectDefault: async (request, options) => parseTicketProjectDefault(await sessions.call('', RPC_V1['projects.ticketProjectDefault'], request, options)),
      inspect: (request, options) => sessions.call('', RPC_V1['projects.inspect'], request, options),
      resolveFileMentions: (request, options) => sessions.call('', RPC_V1['projects.resolveFileMentions'], request, options),
    } satisfies Awaited<ReturnType<ExecutionRuntimeApi['getProjectService']>>;
    const assertAvailable = (options?: ExecutorCallOptions) => {
      options?.signal?.throwIfAborted();
      this.token.assertDispatch();
      if (this.#availability !== 'ready' && this.#availability !== 'reconnecting') {
        throw new AgentCallError('not-dispatched', `Executor is ${this.#availability}`);
      }
    };
    const generation = this;
    this.runtime = Object.freeze({
      id: this.info.executorId,
      get availability() { return generation.#availability; },
      getInfo: async (options) => {
        assertAvailable(options);
        return this.info;
      },
      getAgentIntegration: async (id, options) => {
        assertAvailable(options);
        const integration = this.integrations.get(id);
        if (!integration) throw new AgentCallError('not-dispatched', 'Integration is unavailable on this executor', 'OPERATION_UNSUPPORTED');
        return integration;
      },
      discoverApiProviderModels: (request, options) => sessions.call('', RPC_V1['apiProviders.discoverModels'], request, {
        ...options, timeoutMs: options?.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS + 5_000,
      }),
      getProjectService: async (options) => {
        assertAvailable(options);
        return projects;
      },
      getFilesService: async (options) => {
        assertAvailable(options);
        if (!this.info.services.files) throw unavailableService('files');
        return files;
      },
      getGitService: async (options) => {
        assertAvailable(options);
        if (!this.info.services.git) throw unavailableService('git');
        return git.git;
      },
      getGhService: async (options) => {
        assertAvailable(options);
        if (!this.info.services.gh) throw unavailableService('gh');
        return git.gh;
      },
      getTerminalService: async (options) => {
        assertAvailable(options);
        if (!this.info.services.terminals) throw unavailableService('terminals');
        return this.terminals;
      },
      onAvailabilityChanged: (listener) => {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
      },
      dispose: async () => { if (!this.token.retired) await dispose(); },
    } satisfies ExecutionRuntimeApi);
  }

  setAvailability(value: ExecutorAvailability): void {
    if (this.#availability === value || this.token.retired && value !== 'disposed') return;
    this.#availability = value;
    for (const listener of this.#listeners) listener(value);
  }

  abandonBindings(): void {
    for (const integration of this.integrations.values()) integration.abandonBindings();
    this.terminals.disconnect();
  }

  retire(): void {
    if (this.token.retired) return;
    this.token.retire();
    this.abandonBindings();
    this.setAvailability('disposed');
    this.#listeners.clear();
  }
}

export function staleGeneration(): AgentCallError {
  return new AgentCallError('not-dispatched', 'The executor generation retired before the request was sent.', 'STALE_RESOURCE');
}

export const PROJECT_RPC_CLIENTS = Object.freeze([
  rpcWireV1('apiProviders.discoverModels'),
  rpcWireV1('projects.inspect'),
  rpcWireV1('projects.resolveFileMentions'),
  rpcWireV1('projects.ticketProjectDefault'),
] as const);
