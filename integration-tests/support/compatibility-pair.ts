import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GarconProcess, isolatedEnvironment } from './garcon-process.js';
import { ExecutorProcess, reusableListenPort } from './execution-backend.js';
import type { IntegrationDirectories } from './integration-fixture.js';
import type { SourceArtifact } from './source-artifact.js';
import type { CompatibilityCommand, CompatibilityCredentials, CompatibilityDriverRequest, CompatibilityDriverResult } from './compatibility-contract.js';
import { withTimeout } from './deferred.js';

type Direction = 'remote-controller-dials' | 'remote-executor-dials';
type WorkerLaunch = Parameters<typeof ExecutorProcess.start>[0];

export class CompatibilityPair {
  controller!: GarconProcess;
  worker!: ExecutorProcess;
  executorId = '';
  #workerLaunch!: WorkerLaunch;
  #credentials!: CompatibilityCredentials;
  #port = 0;
  readonly #logs: string[] = [];

  private constructor(
    readonly root: string,
    readonly controllerDirs: IntegrationDirectories,
    readonly workerDirs: IntegrationDirectories,
    private controllerArtifact: SourceArtifact,
    private workerArtifact: SourceArtifact,
    readonly direction: Direction,
  ) {}

  static async start(controller: SourceArtifact, worker: SourceArtifact, direction: Direction, inventory?: string): Promise<CompatibilityPair> {
    const scratch = join(homedir(), 'tmp');
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, 'garcon-compatibility-'));
    const directories = async (name: string): Promise<IntegrationDirectories> => {
      const base = join(root, name);
      const config = join(base, 'config');
      const dirs = { root: base, config, workspace: name === 'worker' ? join(config, 'executor') : join(base, 'workspace'),
        project: join(base, 'project'), home: join(base, 'home') };
      for (const path of Object.values(dirs)) await mkdir(path, { recursive: true });
      return dirs;
    };
    const pair = new CompatibilityPair(root, await directories('controller'), await directories('worker'), controller, worker, direction);
    try {
      pair.#port = await reusableListenPort();
      pair.controller = await pair.#startController();
      const workerOptions = pair.#workerOptions(worker, inventory);
      if (direction === 'remote-controller-dials') {
        pair.#workerLaunch = { ...workerOptions, connection: { kind: 'listen', port: await reusableListenPort([pair.#port]), bindAddress: '0.0.0.0' } };
        pair.worker = await ExecutorProcess.start(pair.#workerLaunch);
        const created = await pair.driver({ kind: 'enroll', direction: 'controller-connects', connectionUrl: await pair.worker.connectionUrl() });
        pair.executorId = stringField(created, 'executorId');
      } else {
        const created = await pair.driver({ kind: 'enroll', direction: 'executor-connects' });
        pair.executorId = stringField(created, 'executorId');
        pair.#workerLaunch = { ...workerOptions, connection: { kind: 'dial', url: stringField(created, 'connectionUrl') } };
        pair.worker = await ExecutorProcess.start(pair.#workerLaunch);
      }
      assert.notEqual(pair.controller.pid, pair.worker.child.pid);
      await pair.worker.connected();
      await pair.ready();
      return pair;
    } catch (error) {
      const logs = pair.diagnostics();
      await pair.dispose().catch(() => undefined);
      throw new Error(`${String(error)}\n${logs}`);
    }
  }

  #workerOptions(artifact: SourceArtifact, inventory?: string): Omit<WorkerLaunch, 'connection'> {
    const environment: Record<string, string> = { GARCON_TERMINAL_SHELL: '/bin/sh' };
    if (inventory) {
      environment.GARCON_TEST_COMPATIBILITY_INVENTORY = inventory;
      environment.GARCON_TEST_COMPATIBILITY_EFFECTS = join(this.workerDirs.root, 'effects.jsonl');
    }
    return {
      ...artifact,
      directories: this.workerDirs,
      environment,
      entrypoint: inventory ? 'integration-tests/support/compatibility-worker.ts' : undefined,
    };
  }

  async #startController(): Promise<GarconProcess> {
    const credentials = await this.#invokeDriver({ version: 1, kind: 'prepare-auth', configDir: this.controllerDirs.config });
    this.#credentials = { username: stringField(credentials, 'username'), password: stringField(credentials, 'password') };
    return GarconProcess.start({ ...this.controllerArtifact, configDir: this.controllerDirs.config,
      workspaceDir: this.controllerDirs.workspace, projectDir: this.controllerDirs.project,
      homeDir: this.controllerDirs.home, environment: { GARCON_TERMINAL_SHELL: '/bin/sh' }, port: this.#port,
      authentication: 'existing',
    });
  }

  driver(command: CompatibilityCommand): Promise<Record<string, unknown>> {
    return this.#invokeDriver({ version: 1, kind: 'command', baseUrl: this.controller.baseUrl,
      credentials: this.#credentials, command });
  }

  cliDriver(artifact: SourceArtifact, request: Extract<CompatibilityDriverRequest, { kind: 'capture-cli-context' | 'check-cli-restart' }>): Promise<Record<string, unknown>> {
    return this.#invokeDriver(request, artifact);
  }

  async #invokeDriver(request: CompatibilityDriverRequest, artifact = this.controllerArtifact): Promise<Record<string, unknown>> {
    const child = Bun.spawn([artifact.bunExecutable, 'integration-tests/support/compatibility-driver.ts'], {
      cwd: artifact.repoRoot, env: isolatedEnvironment(this.controllerDirs.home),
      stdin: new Blob([JSON.stringify(request)]), stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const [code, stdout, stderr] = await withTimeout(Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]), 120_000, () => 'Compatibility driver timed out');
      assert.equal(code, 0, `Artifact-local driver ${request.kind === 'command' ? request.command.kind : request.kind} failed:\n${stderr}`);
      const response: CompatibilityDriverResult = JSON.parse(stdout);
      assert.equal(response.version, 1);
      assert(response.result && typeof response.result === 'object');
      return response.result;
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
  }

  async ready(previousInstance?: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      this.controller.assertNoUnexpectedExit();
      this.worker.assertNoUnexpectedExit();
      const result = await this.driver({ kind: 'inventory', executorId: this.executorId });
      if (result.ready && result.bulkReady && (!previousInstance || result.instanceId !== previousInstance)) return result;
      await Bun.sleep(50);
    }
    throw new Error(`Compatibility pair did not become ready\n${this.diagnostics()}`);
  }

  async restartController(artifact: SourceArtifact): Promise<void> {
    const pid = this.worker.child.pid;
    const before = await this.ready();
    await this.controller.stop();
    this.#logs.push(this.controller.describeLogs());
    this.controllerArtifact = artifact;
    this.controller = await this.#startController();
    const after = await this.ready();
    assert.equal(this.worker.child.pid, pid);
    assert.equal(after.instanceId, before.instanceId);
  }

  async replaceWorker(artifact: SourceArtifact, inventory?: string): Promise<Record<string, unknown>> {
    const previous = await this.ready();
    await this.worker.stop();
    this.#logs.push(...this.worker.logs);
    this.workerArtifact = artifact;
    this.#workerLaunch = { ...this.#workerLaunch, ...this.#workerOptions(artifact, inventory) };
    this.worker = await ExecutorProcess.start(this.#workerLaunch);
    await this.worker.connected();
    return this.ready(stringField(previous, 'instanceId'));
  }

  diagnostics(): string {
    return [...this.#logs, `Controller artifact: ${this.controllerArtifact.repoRoot}; worker artifact: ${this.workerArtifact.repoRoot}`,
      this.controller?.describeLogs() ?? '', ...(this.worker?.logs ?? [])].join('\n');
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const resource of [this.controller, this.worker]) {
      try { await resource?.stop(); } catch (error) { errors.push(error); }
    }
    await rm(this.root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, this.diagnostics());
  }
}

export function stringField(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  assert(typeof result === 'string', `Missing ${key} in compatibility result`);
  return result;
}
