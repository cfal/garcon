import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GarconProcess, isolatedEnvironment, pumpLines, type GarconProcessOptions } from './garcon-process.js';
import { withTimeout } from './deferred.js';
import { BoundedLog } from './bounded-log.js';
import type { IntegrationDirectories } from './integration-fixture.js';
import type { ExecutionNodeConnectionConfig } from '../../server/execution-nodes/config.js';

export type ExecutionBackend = 'in-process' | 'remote-controller-dials' | 'remote-node-dials';

export function executionBackend(value = process.env.GARCON_TEST_EXECUTION_BACKEND ?? 'in-process'): ExecutionBackend {
  if (value !== 'in-process' && value !== 'remote-controller-dials' && value !== 'remote-node-dials') {
    throw new Error(`Unknown execution backend: ${value}`);
  }
  return value;
}

export class ExecutionNodeProcess {
  readonly #logs = new BoundedLog<string>(2000);
  readonly #ready = Promise.withResolvers<void>();
  readonly #listening = Promise.withResolvers<string>();
  readonly #pumps: Promise<void>[];
  #stopping = false;
  #unexpectedExit: Error | null = null;

  private constructor(readonly child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) {
    void this.#ready.promise.catch(() => undefined);
    void this.#listening.promise.catch(() => undefined);
    const capture = (line: string) => {
      this.#logs.push(line);
      const raw = line.replace(/^\[(stdout|stderr)\] /, '');
      if (!raw.startsWith('{')) return;
      try {
        const frame = JSON.parse(raw);
        if (frame.type === 'execution-node-listening') this.#listening.resolve(frame.url);
        if (frame.type === 'execution-node-ready') this.#ready.resolve();
      } catch { /* Provider logs are not worker readiness frames. */ }
    };
    this.#pumps = [pumpLines(child.stdout, 'stdout', () => {}, capture), pumpLines(child.stderr, 'stderr', () => {}, capture)];
    void child.exited.then((code) => {
      if (this.#stopping) return;
      const error = new Error(`Execution worker exited (${code})\n${this.logs.join('\n')}`);
      this.#unexpectedExit = error;
      this.#ready.reject(error); this.#listening.reject(error);
    });
  }

  static async start(input: {
    readonly repoRoot: string;
    readonly directories: IntegrationDirectories;
    readonly environment: Record<string, string>;
    readonly config: ExecutionNodeConnectionConfig;
  }): Promise<ExecutionNodeProcess> {
    const path = join(input.directories.root, 'worker-connection.json');
    await writeFile(path, JSON.stringify({ ...input.config, workspaceDir: input.directories.workspace, projectBasePath: input.directories.project }), { mode: 0o600 });
    const env = isolatedEnvironment(input.directories.home, input.environment);
    await mkdir(env.TMPDIR, { recursive: true });
    const child = Bun.spawn({
      cmd: [process.execPath, 'server/execution-nodes/worker-main.ts', path],
      cwd: input.repoRoot, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    return new ExecutionNodeProcess(child);
  }

  get logs(): readonly string[] { return this.#logs.values(); }
  listening(): Promise<string> { return withTimeout(this.#listening.promise, 20_000, () => `Worker did not listen\n${this.logs.join('\n')}`); }
  ready(): Promise<void> { return withTimeout(this.#ready.promise, 20_000, () => `Worker did not become ready\n${this.logs.join('\n')}`); }

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
  #controllerConfig: ExecutionNodeConnectionConfig | null = null;
  #replacementReady: ReturnType<typeof Promise.withResolvers<void>> | null = null;

  constructor(
    readonly backend: ExecutionBackend,
    readonly directories: IntegrationDirectories,
    readonly environment: Record<string, string>,
  ) {}

  get logs(): readonly string[] { return [...this.#completedLogs, ...(this.#worker?.logs ?? [])]; }

  async start(options: GarconProcessOptions): Promise<GarconProcess> {
    if (this.backend === 'in-process') return GarconProcess.start(options);
    const common = this.#worker && this.#controllerConfig
      ? this.#controllerConfig
      : { nodeId: 'sacs-worker', secret: crypto.randomUUID(), allowInsecureDevelopment: true };
    const configPath = join(this.directories.root, 'controller-connection.json');
    let workerStarted = Promise.resolve();
    const launchWorker = async (connection: ExecutionNodeConnectionConfig['connection']) => {
      this.#workerLaunch = {
        repoRoot: options.repoRoot, directories: this.directories, environment: this.environment,
        config: { ...common, connection },
      };
      this.#worker = await ExecutionNodeProcess.start(this.#workerLaunch);
      if (connection.kind === 'listen') {
        const url = await this.#worker.listening();
        this.#workerLaunch = {
          ...this.#workerLaunch,
          config: { ...this.#workerLaunch.config, connection: { kind: 'listen', port: Number(new URL(url).port) } },
        };
      }
    };
    let controller: GarconProcess | null = null;
    try {
      const connection: ExecutionNodeConnectionConfig['connection'] = this.#worker && this.#controllerConfig
        ? this.#controllerConfig.connection
        : this.backend === 'remote-controller-dials'
        ? await (async () => {
            await launchWorker({ kind: 'listen', port: 0 });
            return { kind: 'dial' as const, url: await this.#worker!.listening() };
          })()
        : { kind: 'listen', port: 0 };
      this.#controllerConfig = { ...common, connection };
      await writeFile(configPath, JSON.stringify({ ...this.#controllerConfig, workspaceDir: options.workspaceDir, projectBasePath: options.projectDir }), { mode: 0o600 });
      controller = await GarconProcess.start({
        ...options,
        environment: { GARCON_AGENT_EXECUTION_NODE_CONFIG: configPath },
        onExecutionNodeReady: () => this.#replacementReady?.resolve(),
        onExecutionNodeListening: (url) => {
          this.#controllerConfig = { ...this.#controllerConfig!, connection: { kind: 'listen', port: Number(new URL(url).port) } };
          workerStarted = this.#worker ? Promise.resolve() : launchWorker({ kind: 'dial', url });
          void workerStarted.catch(() => undefined);
        },
      });
      await workerStarted;
      if (!this.#worker) throw new Error('Remote lane did not launch a worker');
      await this.#worker.ready();
      if (this.#worker.child.pid === controller.pid) throw new Error('Remote lane reused the controller process');
      return controller;
    } catch (error) {
      await controller?.stop().catch(() => undefined);
      await this.stop().catch(() => undefined);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nWorker logs:\n${this.logs.join('\n')}`);
    }
  }

  async crashAndRestartWorker(): Promise<void> {
    if (!this.#worker || !this.#workerLaunch) throw new Error('No remote execution worker is running');
    this.#replacementReady = Promise.withResolvers<void>();
    await this.#worker.crash();
    this.#completedLogs.push(...this.#worker.logs);
    this.#worker = await ExecutionNodeProcess.start(this.#workerLaunch);
    await this.#worker.ready();
    await withTimeout(this.#replacementReady.promise, 20_000, () => `Controller did not promote replacement worker\n${this.logs.join('\n')}`);
    this.#replacementReady = null;
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
