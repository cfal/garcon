import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeOpenAiServer } from './fake-openai-server.js';
import {
  GarconTestClient,
  type ConfiguredTestProvider,
} from './garcon-client.js';
import { GarconProcess } from './garcon-process.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACT_ROOT = join(REPO_ROOT, 'integration-tests', 'artifacts', 'server');
let chatIdSequence = 0;

export interface IntegrationDirectories {
  root: string;
  config: string;
  workspace: string;
  project: string;
  home: string;
}

export interface IntegrationFixtureOptions {
  chatTitleEnabled?: boolean;
}

interface IntegrationProcessRunDiagnostics {
  serverLogs: readonly string[];
  httpExchanges: ReturnType<GarconTestClient['exchanges']>;
  websocketEvents: ReturnType<GarconTestClient['eventRecords']>;
}

export interface IntegrationDiagnostics {
  directories: IntegrationDirectories;
  processRuns: readonly IntegrationProcessRunDiagnostics[];
  providerRequests: ReturnType<FakeOpenAiServer['requests']>;
  providerProtocolViolations: ReturnType<FakeOpenAiServer['protocolViolations']>;
}

export class IntegrationFixture {
  readonly dirs: IntegrationDirectories;
  readonly fakeOpenAi: FakeOpenAiServer;
  readonly provider: ConfiguredTestProvider;
  garcon: GarconProcess;
  client: GarconTestClient;
  readonly #completedRuns: IntegrationProcessRunDiagnostics[] = [];
  #disposed = false;

  private constructor(input: {
    dirs: IntegrationDirectories;
    fakeOpenAi: FakeOpenAiServer;
    garcon: GarconProcess;
    client: GarconTestClient;
    provider: ConfiguredTestProvider;
  }) {
    this.dirs = input.dirs;
    this.fakeOpenAi = input.fakeOpenAi;
    this.garcon = input.garcon;
    this.client = input.client;
    this.provider = input.provider;
  }

  static async create(options: IntegrationFixtureOptions = {}): Promise<IntegrationFixture> {
    const root = await mkdtemp(join(tmpdir(), 'garcon-integration-'));
    const dirs: IntegrationDirectories = {
      root,
      config: join(root, 'config'),
      workspace: join(root, 'workspace'),
      project: join(root, 'project'),
      home: join(root, 'home'),
    };
    await Promise.all(Object.values(dirs).map((directory) => mkdir(directory, { recursive: true })));

    const fakeOpenAi = FakeOpenAiServer.start();
    let garcon: GarconProcess | null = null;
    let client: GarconTestClient | null = null;
    try {
      garcon = await GarconProcess.start({
        repoRoot: REPO_ROOT,
        configDir: dirs.config,
        workspaceDir: dirs.workspace,
        projectDir: dirs.project,
        homeDir: dirs.home,
      });
      client = await GarconTestClient.connect(garcon.baseUrl);
      await client.ping();
      const provider = await client.createOpenAiProvider(fakeOpenAi.baseUrl);
      await client.updateSettings({
        ui: { chatTitle: { enabled: options.chatTitleEnabled ?? false } },
      });
      return new IntegrationFixture({ dirs, fakeOpenAi, garcon, client, provider });
    } catch (error) {
      await client?.close().catch(() => undefined);
      await garcon?.stop().catch(() => undefined);
      fakeOpenAi.stop();
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  newChatId(): string {
    chatIdSequence = (chatIdSequence + 1) % 1_000;
    return String(Date.now() * 1_000 + chatIdSequence);
  }

  async restartGarcon(): Promise<void> {
    await this.client.close();
    await this.garcon.stop();
    this.#archiveCurrentRun();
    await this.#startReplacementGarcon();
  }

  async crashAndRestartGarcon(): Promise<void> {
    await this.client.close();
    await this.garcon.crash();
    const expiredAt = new Date(Date.now() - 60_000);
    await utimes(
      join(this.dirs.workspace, '.garcon-workspace.lock'),
      expiredAt,
      expiredAt,
    );
    this.#archiveCurrentRun();
    await this.#startReplacementGarcon();
  }

  diagnostics(): IntegrationDiagnostics {
    return {
      directories: this.dirs,
      processRuns: [...this.#completedRuns, this.#currentRunDiagnostics()],
      providerRequests: this.fakeOpenAi.requests(),
      providerProtocolViolations: this.fakeOpenAi.protocolViolations(),
    };
  }

  async writeDiagnostics(testName: string, error?: unknown): Promise<string> {
    const safeName = testName.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    const path = join(ARTIFACT_ROOT, `${safeName || 'integration'}-${Date.now()}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      testName,
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error === undefined ? null : String(error),
      ...this.diagnostics(),
    }, null, 2));
    return path;
  }

  describe(): string {
    return [
      `Directories: ${JSON.stringify(this.dirs, null, 2)}`,
      `Process runs:\n${JSON.stringify(this.diagnostics().processRuns, null, 2)}`,
      `Provider requests:\n${this.fakeOpenAi.describeRequests()}`,
    ].join('\n\n');
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    try {
      await this.client.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.garcon.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.fakeOpenAi.assertNoProtocolViolations();
      this.garcon.assertNoUnexpectedExit();
    } catch (error) {
      errors.push(error);
    }
    this.fakeOpenAi.stop();

    if (errors.length === 0 && process.env.KEEP_INTEGRATION_ARTIFACTS !== '1') {
      await rm(this.dirs.root, { recursive: true, force: true });
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Integration fixture cleanup failed.\n${this.describe()}`);
    }
  }

  async #startReplacementGarcon(): Promise<void> {
    this.garcon = await GarconProcess.start({
      repoRoot: REPO_ROOT,
      configDir: this.dirs.config,
      workspaceDir: this.dirs.workspace,
      projectDir: this.dirs.project,
      homeDir: this.dirs.home,
    });
    this.client = await GarconTestClient.connect(this.garcon.baseUrl);
    await this.client.ping();
  }

  #archiveCurrentRun(): void {
    this.#completedRuns.push(this.#currentRunDiagnostics());
  }

  #currentRunDiagnostics(): IntegrationProcessRunDiagnostics {
    return {
      serverLogs: this.garcon.logs,
      httpExchanges: this.client.exchanges(),
      websocketEvents: this.client.eventRecords(),
    };
  }
}

export function createIntegrationFixture(
  options: IntegrationFixtureOptions = {},
): Promise<IntegrationFixture> {
  return IntegrationFixture.create(options);
}

export async function withIntegrationFixture<T>(
  testName: string,
  run: (fixture: IntegrationFixture) => Promise<T>,
  options: IntegrationFixtureOptions = {},
): Promise<T> {
  const fixture = await createIntegrationFixture(options);
  let failure: unknown;
  try {
    return await run(fixture);
  } catch (error) {
    failure = error;
    const artifact = await fixture.writeDiagnostics(testName, error).catch(() => null);
    if (artifact && error instanceof Error) {
      error.message = `${error.message}\nIntegration diagnostics: ${artifact}\n${fixture.describe()}`;
    }
    throw error;
  } finally {
    try {
      await fixture.dispose();
    } catch (disposeError) {
      if (failure === undefined) throw disposeError;
      console.error(disposeError);
    }
  }
}
