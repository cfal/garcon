import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  type AgentId,
} from '../../common/agents.js';
import { FakeAnthropicServer } from './fake-anthropic-server.js';
import { FakeOpenAiServer } from './fake-openai-server.js';
import {
  GarconTestClient,
  type ConfiguredDirectTestAgent,
  type ConfiguredTestProvider,
  type DirectTestAgents,
} from './garcon-client.js';
import { GarconProcess } from './garcon-process.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACT_ROOT = join(REPO_ROOT, 'integration-tests', 'artifacts', 'server');
let chatIdSequence = 0;

function directAgent(
  agentId: AgentId,
  provider: ConfiguredTestProvider,
): ConfiguredDirectTestAgent {
  return {
    agentId,
    provider,
    agentSettings: { ownerId: agentId, schemaVersion: 1, values: {} },
  };
}

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
  clients: Array<{
    name: string;
    httpExchanges: ReturnType<GarconTestClient['exchanges']>;
    websocketEvents: ReturnType<GarconTestClient['eventRecords']>;
  }>;
}

export interface IntegrationDiagnostics {
  directories: IntegrationDirectories;
  processRuns: readonly IntegrationProcessRunDiagnostics[];
  providers: {
    openAi: {
      requests: ReturnType<FakeOpenAiServer['requests']>;
      protocolViolations: ReturnType<FakeOpenAiServer['protocolViolations']>;
    };
    anthropic: {
      requests: ReturnType<FakeAnthropicServer['diagnosticRequests']>;
      protocolViolations: ReturnType<FakeAnthropicServer['protocolViolations']>;
    };
  };
}

export class IntegrationFixture {
  readonly dirs: IntegrationDirectories;
  readonly fakeProviders: {
    openAi: FakeOpenAiServer;
    anthropic: FakeAnthropicServer;
  };
  readonly directAgents: DirectTestAgents;
  garcon: GarconProcess;
  client: GarconTestClient;
  readonly #clients = new Map<string, GarconTestClient>();
  readonly #completedRuns: IntegrationProcessRunDiagnostics[] = [];
  #disposed = false;

  private constructor(input: {
    dirs: IntegrationDirectories;
    fakeProviders: IntegrationFixture['fakeProviders'];
    garcon: GarconProcess;
    client: GarconTestClient;
    directAgents: DirectTestAgents;
  }) {
    this.dirs = input.dirs;
    this.fakeProviders = input.fakeProviders;
    this.garcon = input.garcon;
    this.client = input.client;
    this.#clients.set('primary', input.client);
    this.directAgents = input.directAgents;
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

    const fakeProviders = {
      openAi: FakeOpenAiServer.start(),
      anthropic: FakeAnthropicServer.start(),
    };
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
      const openAiProvider = await client.createOpenAiProvider(fakeProviders.openAi.baseUrl);
      const anthropicProvider = await client.createAnthropicProvider(fakeProviders.anthropic.baseUrl);
      const directAgents = {
        openAi: directAgent(
          DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
          openAiProvider,
        ),
        anthropic: directAgent(
          DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
          anthropicProvider,
        ),
      } satisfies DirectTestAgents;
      await client.updateSettings({
        ui: {
          chatTitle: options.chatTitleEnabled ? {
            enabled: true,
            agentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
            model: openAiProvider.model,
            apiProviderId: openAiProvider.providerId,
            modelEndpointId: openAiProvider.endpointId,
            modelProtocol: openAiProvider.protocol,
            thinkingMode: 'none',
          } : { enabled: false },
        },
      });
      return new IntegrationFixture({ dirs, fakeProviders, garcon, client, directAgents });
    } catch (error) {
      await client?.close().catch(() => undefined);
      await garcon?.stop().catch(() => undefined);
      fakeProviders.openAi.stop();
      fakeProviders.anthropic.stop();
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  newChatId(): string {
    chatIdSequence = (chatIdSequence + 1) % 1_000;
    return String(Date.now() * 1_000 + chatIdSequence);
  }

  async connectObserver(name: string): Promise<GarconTestClient> {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName === 'primary') {
      throw new Error('Observer name must be non-empty and cannot be "primary".');
    }
    if (this.#clients.has(normalizedName)) {
      throw new Error(`Integration client already exists: ${normalizedName}`);
    }
    const observer = await GarconTestClient.connect(this.garcon.baseUrl);
    try {
      await observer.ping();
      this.#clients.set(normalizedName, observer);
      return observer;
    } catch (error) {
      await observer.close().catch(() => undefined);
      throw error;
    }
  }

  async restartGarcon(): Promise<void> {
    await this.#closeClients();
    await this.garcon.stop();
    this.#archiveCurrentRun();
    this.#clients.clear();
    await this.#startReplacementGarcon();
  }

  async crashAndRestartGarcon(): Promise<void> {
    await this.#closeClients();
    await this.garcon.crash();
    const expiredAt = new Date(Date.now() - 60_000);
    await utimes(
      join(this.dirs.workspace, '.garcon-workspace.lock'),
      expiredAt,
      expiredAt,
    );
    this.#archiveCurrentRun();
    this.#clients.clear();
    await this.#startReplacementGarcon();
  }

  diagnostics(): IntegrationDiagnostics {
    return {
      directories: this.dirs,
      processRuns: [...this.#completedRuns, this.#currentRunDiagnostics()],
      providers: {
        openAi: {
          requests: this.fakeProviders.openAi.requests(),
          protocolViolations: this.fakeProviders.openAi.protocolViolations(),
        },
        anthropic: {
          requests: this.fakeProviders.anthropic.diagnosticRequests(),
          protocolViolations: this.fakeProviders.anthropic.protocolViolations(),
        },
      },
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
      `OpenAI requests:\n${this.fakeProviders.openAi.describeRequests()}`,
      `Anthropic requests:\n${this.fakeProviders.anthropic.describeRequests()}`,
    ].join('\n\n');
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    try {
      await this.#closeClients();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.garcon.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.fakeProviders.openAi.assertNoProtocolViolations();
      this.fakeProviders.anthropic.assertNoProtocolViolations();
      this.garcon.assertNoUnexpectedExit();
    } catch (error) {
      errors.push(error);
    }
    this.fakeProviders.openAi.stop();
    this.fakeProviders.anthropic.stop();

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
    this.#clients.set('primary', this.client);
    try {
      await this.client.ping();
    } catch (error) {
      await this.client.close().catch(() => undefined);
      throw error;
    }
  }

  #archiveCurrentRun(): void {
    this.#completedRuns.push(this.#currentRunDiagnostics());
  }

  #currentRunDiagnostics(): IntegrationProcessRunDiagnostics {
    return {
      serverLogs: this.garcon.logs,
      clients: [...this.#clients].map(([name, client]) => ({
        name,
        httpExchanges: client.exchanges(),
        websocketEvents: client.eventRecords(),
      })),
    };
  }

  async #closeClients(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#clients.values()].map((client) => client.close()),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close integration clients.');
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
