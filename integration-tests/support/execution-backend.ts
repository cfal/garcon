import { mkdir, readFile, utimes } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { GarconProcess, isolatedEnvironment, pumpLines, type GarconProcessOptions } from './garcon-process.js';
import { withTimeout } from './deferred.js';
import { BoundedLog } from './bounded-log.js';
import type { IntegrationDirectories } from './integration-fixture.js';
import { parseExecutors, type ExecutorConnection } from '../../common/executors.js';

export type ExecutionBackend = 'in-process' | 'remote-controller-dials' | 'remote-executor-dials';

export function executionBackend(value = process.env.GARCON_TEST_EXECUTION_BACKEND ?? 'in-process'): ExecutionBackend {
  if (value !== 'in-process' && value !== 'remote-controller-dials' && value !== 'remote-executor-dials') {
    throw new Error(`Unknown execution backend: ${value}`);
  }
  return value;
}

const WORKER_PORT_SPAN = 10_000;

async function ephemeralPortFloor(): Promise<number> {
  try {
    const [floor] = (await readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')).trim().split(/\s+/);
    if (Number.isInteger(Number(floor))) return Number(floor);
  } catch { /* Non-Linux hosts fall back to the IANA dynamic range. */ }
  return 49_152;
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

// Restarted controllers and relaunched workers listen on their previous ports. While a process is
// down, the kernel may assign a released ephemeral port to any socket, including a peer's redial of
// that port from the same host, so reused ports come from below the range it assigns implicitly.
export async function reusableListenPort(): Promise<number> {
  const floor = await ephemeralPortFloor();
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = floor - 1 - Math.floor(Math.random() * WORKER_PORT_SPAN);
    if (port >= 1024 && await canListen(port)) return port;
  }
  throw new Error(`No free worker port below the ephemeral range at ${floor}`);
}

export class ExecutorProcess {
  readonly #logs = new BoundedLog<string>(2000);
  readonly #connected = Promise.withResolvers<void>();
  readonly #listening = Promise.withResolvers<string>();
  readonly #pumps: Promise<void>[];
  #stopping = false;
  #unexpectedExit: Error | null = null;

  private constructor(readonly child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>, private readonly launch: { repoRoot: string; configDir: string }) {
    void this.#connected.promise.catch(() => undefined);
    void this.#listening.promise.catch(() => undefined);
    const capture = (line: string) => {
      const raw = line.replace(/^\[(stdout|stderr)\] /, '');
      if (!raw.startsWith('{')) { this.#logs.push(line); return; }
      try {
        const frame = JSON.parse(raw);
        if (frame.type === 'executor-listening') {
          this.#listening.resolve(frame.url);
          this.#logs.push(JSON.stringify({ type: frame.type, url: frame.url }));
          return;
        }
        if (frame.type === 'executor-connected') this.#connected.resolve();
      } catch { /* Provider logs are not worker readiness frames. */ }
      this.#logs.push(line);
    };
    this.#pumps = [pumpLines(child.stdout, 'stdout', () => {}, capture), pumpLines(child.stderr, 'stderr', () => {}, capture)];
    void child.exited.then((code) => {
      if (this.#stopping) return;
      const error = new Error(`Execution worker exited (${code})\n${this.logs.join('\n')}`);
      this.#unexpectedExit = error;
      this.#connected.reject(error); this.#listening.reject(error);
    });
  }

  static async start(input: {
    readonly repoRoot: string;
    readonly directories: IntegrationDirectories;
    readonly environment: Record<string, string>;
    readonly connection: { readonly kind: 'listen'; readonly port: number; readonly bindAddress?: string } | { readonly kind: 'dial'; readonly url: string };
  }): Promise<ExecutorProcess> {
    const env = isolatedEnvironment(input.directories.home, input.environment);
    await mkdir(env.TMPDIR, { recursive: true });
    const child = Bun.spawn({
      cmd: [process.execPath, 'server/main.ts', 'executor',
        ...(input.connection.kind === 'listen' ? ['--listen', String(input.connection.port)] : []),
        ...(input.connection.kind === 'listen' && input.connection.bindAddress ? ['--bind-address', input.connection.bindAddress] : []),
        '--no-tls', '--config-dir', input.directories.config,
        '--project-base-dir', input.directories.project],
      cwd: input.repoRoot, env: { ...env, GARCON_CONTROLLER_URL: input.connection.kind === 'dial' ? input.connection.url : '' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    return new ExecutorProcess(child, { repoRoot: input.repoRoot, configDir: input.directories.config });
  }

  get logs(): readonly string[] { return this.#logs.values(); }
  listening(): Promise<string> { return withTimeout(this.#listening.promise, 20_000, () => `Worker did not listen\n${this.logs.join('\n')}`); }
  async connectionUrl(): Promise<string> {
    const address = new URL(await this.listening());
    if (address.hostname === '0.0.0.0' || address.hostname === '[::]') address.hostname = '127.0.0.1';
    const reveal = Bun.spawn([process.execPath, 'server/main.ts', 'executor', 'connection-url',
      '--config-dir', this.launch.configDir, '--advertise-url', address.href, '--no-tls'],
    { cwd: this.launch.repoRoot, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const result = (await new Response(reveal.stdout).text()).trim();
    if (await reveal.exited !== 0) throw new Error('Worker credential reveal failed');
    return result;
  }
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
  #worker: ExecutorProcess | null = null;
  readonly #completedLogs: string[] = [];
  #workerLaunch: Parameters<typeof ExecutorProcess.start>[0] | null = null;
  #executorId: string | null = null;
  #controllerUrl: string | null = null;
  #controllerAuthToken: string | null = null;
  readonly executionProcessIds = new Set<number>();

  constructor(
    readonly backend: ExecutionBackend,
    readonly directories: IntegrationDirectories,
    readonly environment: Record<string, string>,
    private readonly interceptConnection?: (url: URL) => Promise<string>,
  ) {}

  get logs(): readonly string[] { return [...this.#completedLogs, ...(this.#worker?.logs ?? [])]; }
  get executorId(): string { return this.#executorId ?? 'local'; }

  async start(options: GarconProcessOptions): Promise<GarconProcess> {
    const port = this.backend === 'remote-executor-dials' && this.#controllerUrl
      ? Number(new URL(this.#controllerUrl).port)
      : options.port ?? await reusableListenPort();
    if (this.backend === 'in-process') {
      const controller = await GarconProcess.start({ ...options, port });
      if (controller.pid !== null) this.executionProcessIds.add(controller.pid);
      return controller;
    }
    const launchWorker = async (connection: Parameters<typeof ExecutorProcess.start>[0]['connection']) => {
      this.#workerLaunch = {
        repoRoot: options.repoRoot, directories: this.directories, environment: this.environment,
        connection,
      };
      this.#worker = await ExecutorProcess.start(this.#workerLaunch);
      this.executionProcessIds.add(this.#worker.child.pid);
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
      controller = await GarconProcess.start({ ...options, port });
      this.#controllerUrl = controller.baseUrl;
      this.#controllerAuthToken = controller.authToken;
      if (this.backend === 'remote-controller-dials') {
        if (!this.#worker) {
          await launchWorker(this.#workerLaunch?.connection ?? { kind: 'listen', port: await reusableListenPort() });
        }
        if (!this.#executorId) {
          const url = new URL(await this.#worker!.connectionUrl());
          url.hostname = '127.0.0.1';
          const created = await this.#request<{ id: string }>('/api/v1/executors', 'POST', {
            label: 'Integration worker', direction: 'controller-connects',
            connectionUrl: await this.interceptConnection?.(url) ?? url.href, noTls: true,
          });
          this.#executorId = created.id;
        }
      } else {
        if (!this.#executorId) {
          const created = await this.#request<{ id: string } & ExecutorConnection>('/api/v1/executors', 'POST', {
            label: 'Integration worker', direction: 'executor-connects', noTls: true,
          });
          this.#executorId = created.id;
          const url = new URL(created.connectionUrl);
          const controllerUrl = new URL(controller.baseUrl);
          url.protocol = 'ws:';
          url.host = controllerUrl.host;
          url.pathname = `/executor/${created.id}`;
          const connectionUrl = await this.interceptConnection?.(url) ?? url.href;
          await this.#request(`/api/v1/executors/${this.#executorId}`, 'PATCH', {
            connection: { direction: 'executor-connects', connectionUrl, noTls: true },
          });
          this.#workerLaunch = { repoRoot: options.repoRoot, directories: this.directories, environment: this.environment,
            connection: { kind: 'dial', url: connectionUrl } };
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
    this.#worker = await ExecutorProcess.start(this.#workerLaunch);
    this.executionProcessIds.add(this.#worker.child.pid);
    await this.#worker.connected();
    await this.#waitReady();
  }

  async #request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${this.#controllerUrl}${path}`, {
      method, headers: { 'Content-Type': 'application/json',
        ...(this.#controllerAuthToken ? { Authorization: `Bearer ${this.#controllerAuthToken}` } : {}),
      }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Executor fixture request failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  async #waitReady(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      this.#worker?.assertNoUnexpectedExit();
      const result = await this.#request<{ executors: unknown }>('/api/v1/executors');
      const executors = parseExecutors(result.executors);
      if (!executors) throw new Error('Invalid executor snapshot');
      if (executors.some((executor) => executor.id === this.#executorId && executor.availability === 'ready')) return;
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
