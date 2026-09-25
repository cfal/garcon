import { mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { GarconProcess, isolatedEnvironment, pumpLines, type GarconProcessOptions } from './garcon-process.js';
import { withTimeout } from './deferred.js';
import { BoundedLog } from './bounded-log.js';
import type { IntegrationDirectories } from './integration-fixture.js';
import { parseExecutionNodes, type ExecutionNodeConnection } from '../../common/execution-nodes.js';

export type ExecutionBackend = 'in-process' | 'remote-controller-dials' | 'remote-node-dials';

export function executionBackend(value = process.env.GARCON_TEST_EXECUTION_BACKEND ?? 'in-process'): ExecutionBackend {
  if (value !== 'in-process' && value !== 'remote-controller-dials' && value !== 'remote-node-dials') {
    throw new Error(`Unknown execution backend: ${value}`);
  }
  return value;
}

export class ExecutionNodeProcess {
  readonly #logs = new BoundedLog<string>(2000);
  readonly #connected = Promise.withResolvers<void>();
  readonly #listening = Promise.withResolvers<string>();
  readonly #connection = Promise.withResolvers<string>();
  readonly #pumps: Promise<void>[];
  #stopping = false;
  #unexpectedExit: Error | null = null;

  private constructor(readonly child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) {
    void this.#connected.promise.catch(() => undefined);
    void this.#listening.promise.catch(() => undefined);
    void this.#connection.promise.catch(() => undefined);
    const capture = (line: string) => {
      const raw = line.replace(/^\[(stdout|stderr)\] /, '');
      if (!raw.startsWith('{')) { this.#logs.push(line); return; }
      try {
        const frame = JSON.parse(raw);
        if (frame.type === 'execution-node-listening') {
          this.#listening.resolve(frame.url);
          this.#connection.resolve(frame.connectionUrl);
          this.#logs.push(JSON.stringify({ type: frame.type, url: frame.url }));
          return;
        }
        if (frame.type === 'execution-node-connected') this.#connected.resolve();
      } catch { /* Provider logs are not worker readiness frames. */ }
      this.#logs.push(line);
    };
    this.#pumps = [pumpLines(child.stdout, 'stdout', () => {}, capture), pumpLines(child.stderr, 'stderr', () => {}, capture)];
    void child.exited.then((code) => {
      if (this.#stopping) return;
      const error = new Error(`Execution worker exited (${code})\n${this.logs.join('\n')}`);
      this.#unexpectedExit = error;
      this.#connected.reject(error); this.#listening.reject(error); this.#connection.reject(error);
    });
  }

  static async start(input: {
    readonly repoRoot: string;
    readonly directories: IntegrationDirectories;
    readonly environment: Record<string, string>;
    readonly connection: { readonly kind: 'listen'; readonly port: number; readonly bindAddress?: string } | { readonly kind: 'dial'; readonly url: string };
  }): Promise<ExecutionNodeProcess> {
    const env = isolatedEnvironment(input.directories.home, input.environment);
    await mkdir(env.TMPDIR, { recursive: true });
    const child = Bun.spawn({
      cmd: [process.execPath, 'server/main.ts', 'execution-node',
        ...(input.connection.kind === 'listen' ? ['--listen', String(input.connection.port)] : ['--connect', input.connection.url]),
        ...(input.connection.kind === 'listen' && input.connection.bindAddress ? ['--bind-address', input.connection.bindAddress] : []),
        '--allow-insecure-development', '--config-dir', input.directories.config,
        '--project-base-dir', input.directories.project],
      cwd: input.repoRoot, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    return new ExecutionNodeProcess(child);
  }

  get logs(): readonly string[] { return this.#logs.values(); }
  listening(): Promise<string> { return withTimeout(this.#listening.promise, 20_000, () => `Worker did not listen\n${this.logs.join('\n')}`); }
  connectionUrl(): Promise<string> { return withTimeout(this.#connection.promise, 20_000, () => 'Worker did not print its connection URL'); }
  connected(): Promise<void> { return withTimeout(this.#connected.promise, 20_000, () => `Worker did not connect\n${this.logs.join('\n')}`); }

  async stop(): Promise<void> {
    if (!this.#stopping && this.child.exitCode === null) {
      this.#stopping = true;
      this.child.kill('SIGTERM');
    }
    try {
      await withTimeout(this.child.exited, 15_000, () => `Worker did not stop\n${this.logs.join('\n')}`);
    } catch (error) {
      this.child.kill('SIGKILL');
      await this.child.exited;
      throw error;
    } finally { await Promise.allSettled(this.#pumps); }
    this.assertNoUnexpectedExit();
  }

  async crash(): Promise<void> {
    if (this.child.exitCode === null) {
      this.#stopping = true;
      this.child.kill('SIGKILL');
    }
    await this.child.exited;
    await Promise.allSettled(this.#pumps);
    this.assertNoUnexpectedExit();
  }

  assertNoUnexpectedExit(): void {
    if (this.#unexpectedExit) throw this.#unexpectedExit;
  }
}

export class ExecutionBackendFixture {
  #worker: ExecutionNodeProcess | null = null;
  readonly #completedLogs: string[] = [];
  #workerLaunch: Parameters<typeof ExecutionNodeProcess.start>[0] | null = null;
  #nodeId: string | null = null;
  #controllerUrl: string | null = null;
  #controllerAuthToken: string | null = null;

  constructor(
    readonly backend: ExecutionBackend,
    readonly directories: IntegrationDirectories,
    readonly environment: Record<string, string>,
  ) {}

  get logs(): readonly string[] { return [...this.#completedLogs, ...(this.#worker?.logs ?? [])]; }
  get nodeId(): string { return this.#nodeId ?? 'local'; }

  async start(options: GarconProcessOptions): Promise<GarconProcess> {
    if (this.backend === 'in-process') return GarconProcess.start(options);
    const launchWorker = async (connection: Parameters<typeof ExecutionNodeProcess.start>[0]['connection']) => {
      this.#workerLaunch = {
        repoRoot: options.repoRoot, directories: this.directories, environment: this.environment,
        connection,
      };
      this.#worker = await ExecutionNodeProcess.start(this.#workerLaunch);
      if (connection.kind === 'listen') {
        const url = await this.#worker.listening();
        this.#workerLaunch = {
          ...this.#workerLaunch,
          connection: { kind: 'listen', port: Number(new URL(url).port) },
        };
      }
    };
    let controller: GarconProcess | null = null;
    try {
      controller = await GarconProcess.start({
        ...options,
        ...(this.backend === 'remote-node-dials' && this.#controllerUrl
          ? { port: Number(new URL(this.#controllerUrl).port) } : {}),
      });
      this.#controllerUrl = controller.baseUrl;
      this.#controllerAuthToken = controller.authToken;
      if (this.backend === 'remote-controller-dials') {
        if (!this.#worker) await launchWorker(this.#workerLaunch?.connection ?? { kind: 'listen', port: 0 });
        if (!this.#nodeId) {
          const url = new URL(await this.#worker!.connectionUrl());
          url.hostname = '127.0.0.1';
          const created = await this.#request<{ id: string }>('/api/v1/execution-nodes', 'POST', {
            label: 'Integration worker', direction: 'controller-connects', connectionUrl: url.href, allowInsecureDevelopment: true,
          });
          this.#nodeId = created.id;
        }
      } else {
        if (!this.#nodeId) {
          const created = await this.#request<{ id: string } & ExecutionNodeConnection>('/api/v1/execution-nodes', 'POST', {
            label: 'Integration worker', direction: 'node-connects', allowInsecureDevelopment: true,
          });
          this.#nodeId = created.id;
          const url = new URL(created.connectionUrl);
          const controllerUrl = new URL(controller.baseUrl);
          url.protocol = 'ws:';
          url.host = controllerUrl.host;
          await this.#request(`/api/v1/execution-nodes/${this.#nodeId}`, 'PATCH', {
            connection: { direction: 'node-connects', connectionUrl: url.href, allowInsecureDevelopment: true },
          });
          this.#workerLaunch = { repoRoot: options.repoRoot, directories: this.directories, environment: this.environment,
            connection: { kind: 'dial', url: url.href } };
        }
        if (!this.#worker) await launchWorker(this.#workerLaunch!.connection);
      }
      if (!this.#worker) throw new Error('Remote lane did not launch a worker');
      await this.#worker.connected();
      await this.#waitReady();
      if (this.#worker.child.pid === controller.pid) throw new Error('Remote lane reused the controller process');
      return controller;
    } catch (error) {
      await controller?.stop().catch(() => undefined);
      await this.stop().catch(() => undefined);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nWorker logs:\n${this.logs.join('\n')}`);
    }
  }

  async crashAndRestartWorker(projectBasePath?: string): Promise<void> {
    if (!this.#worker || !this.#workerLaunch) throw new Error('No remote execution worker is running');
    await this.#worker.crash();
    const expiredAt = new Date(Date.now() - 60_000);
    await utimes(join(this.directories.workspace, '.garcon-workspace.lock'), expiredAt, expiredAt);
    this.#completedLogs.push(...this.#worker.logs);
    if (projectBasePath !== undefined) {
      this.#workerLaunch = { ...this.#workerLaunch, directories: { ...this.#workerLaunch.directories, project: projectBasePath } };
    }
    this.#worker = await ExecutionNodeProcess.start(this.#workerLaunch);
    await this.#worker.connected();
    await this.#waitReady();
  }

  async #request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${this.#controllerUrl}${path}`, {
      method, headers: { 'Content-Type': 'application/json',
        ...(this.#controllerAuthToken ? { Authorization: `Bearer ${this.#controllerAuthToken}` } : {}),
      }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Execution-node fixture request failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  async #waitReady(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      this.#worker?.assertNoUnexpectedExit();
      const result = await this.#request<{ nodes: unknown }>('/api/v1/execution-nodes');
      const nodes = parseExecutionNodes(result.nodes);
      if (!nodes) throw new Error('Invalid execution-node snapshot');
      if (nodes.some((node) => node.id === this.#nodeId && node.availability === 'ready')) return;
      await Bun.sleep(50);
    }
    throw new Error(`Controller did not initialize execution worker\n${this.logs.join('\n')}`);
  }

  async stop(): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    if (worker) {
      try { await worker.stop(); }
      finally { this.#completedLogs.push(...worker.logs); }
    }
  }
}
