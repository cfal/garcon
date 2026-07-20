import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  prepareWorkspace?: (directories: IntegrationDirectories) => Promise<void>;
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
      await options.prepareWorkspace?.(dirs);
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

  async restartGarcon(options: { beforeStart?: () => Promise<void> } = {}): Promise<void> {
    await this.#closeClients();
    await this.garcon.stop();
    this.#archiveCurrentRun();
    this.#clients.clear();
    await options.beforeStart?.();
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

  async crashAndRestartBeforeNativeUserPersistence(input: {
    chatId: string;
    clientRequestId: string;
    afterCrash?: () => Promise<void>;
  }): Promise<void> {
    await this.client.close();
    await this.garcon.crash();
    const expiredAt = new Date(Date.now() - 60_000);
    await utimes(
      join(this.dirs.workspace, '.garcon-workspace.lock'),
      expiredAt,
      expiredAt,
    );
    await this.#removeFinalNativeUserRow(input);
    await input.afterCrash?.();
    this.#archiveCurrentRun();
    await this.#startReplacementGarcon();
  }

  async #removeFinalNativeUserRow(input: { chatId: string; clientRequestId: string }): Promise<void> {
    const registry = JSON.parse(
      await readFile(join(this.dirs.workspace, 'chats.json'), 'utf8'),
    ) as { sessions?: Record<string, Record<string, unknown>> };
    const chat = registry.sessions?.[input.chatId];
    if (!chat) throw new Error(`Chat ${input.chatId} was not persisted before crash.`);
    if (chat.agentId !== DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID) {
      throw new Error(`Chat ${input.chatId} is not a direct OpenAI-compatible chat.`);
    }
    const nativeSession = chat.nativeSession && typeof chat.nativeSession === 'object'
      ? chat.nativeSession as Record<string, unknown>
      : null;
    const nativeValue = nativeSession?.value && typeof nativeSession.value === 'object'
      ? nativeSession.value as Record<string, unknown>
      : null;
    const nativePath = typeof nativeValue?.path === 'string' ? nativeValue.path : '';
    const endpointId = typeof chat.modelEndpointId === 'string' ? chat.modelEndpointId : '';
    const sessionId = typeof chat.agentSessionId === 'string' ? chat.agentSessionId : '';
    const expectedPath = resolve(
      this.dirs.workspace,
      'agent-data',
      DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      'openai-compatible-sessions',
      endpointId,
      `${sessionId}.jsonl`,
    );
    if (
      nativeSession?.ownerId !== DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID
      || nativeSession.schemaVersion !== 1
      || !nativePath
      || resolve(nativePath) !== expectedPath
    ) {
      throw new Error(`Chat ${input.chatId} has an unexpected native transcript path.`);
    }

    const raw = await readFile(expectedPath, 'utf8');
    if (!raw.endsWith('\n')) throw new Error('Direct native transcript has an incomplete tail.');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    const rows = lines.map((line, index) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        return parsed as Record<string, unknown>;
      } catch {
        throw new Error(`Direct native transcript has malformed JSON at line ${index + 1}.`);
      }
    });
    const matchingIndexes = rows.flatMap((row, index) => (
      row.role === 'user' && row.clientRequestId === input.clientRequestId ? [index] : []
    ));
    if (matchingIndexes.length !== 1 || matchingIndexes[0] !== rows.length - 1) {
      throw new Error('Expected exactly one final native user row with the accepted request identity.');
    }
    const retained = lines.slice(0, -1);
    await writeFile(expectedPath, retained.length > 0 ? `${retained.join('\n')}\n` : '', 'utf8');
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
