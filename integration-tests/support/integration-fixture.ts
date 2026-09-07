import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  type AgentId,
} from '../../common/agents.js';
import { FakeAnthropicServer } from './fake-anthropic-server.js';
import { FakeOpenAiServer } from './fake-openai-server.js';
import { FakeOpenAiResponsesServer } from './fake-openai-responses-server.js';
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
  chatTitleAgent?: keyof DirectTestAgents;
  forbiddenPersistedValues?: readonly string[];
  prepareWorkspace?: (directories: IntegrationDirectories) => Promise<void>;
  // Runs after the final Garcon child exits and before the fixture root can be removed;
  // the only reliable place to inspect provider grandchildren. Hook failures join the
  // fixture's cleanup errors and preserve its artifact root.
  afterGarconStop?: (directories: IntegrationDirectories) => Promise<void>;
  // Synchronous bounded diagnostics added under an `extensions` key in failure artifacts.
  extraDiagnostics?: (directories: IntegrationDirectories) => Record<string, unknown>;
  // Derives environment from the created fixture directories; resolved once before
  // prepareWorkspace and reused for every replacement process. Resolver values win over
  // static serverEnvironment entries with the same name.
  resolveServerEnvironment?: (
    directories: IntegrationDirectories,
  ) => Record<string, string>;
  redactSensitiveDiagnostics?: boolean;
  serverEnvironment?: Record<string, string>;
  namedWorkspace?: string;
}

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:api[_-]?key|auth[_-]?token|credential|password|secret|token)/i;

function sensitiveEnvironmentValues(environment: Record<string, string>): string[] {
  return [...new Set(Object.entries(environment)
    .filter(([name, value]) => SENSITIVE_ENVIRONMENT_NAME.test(name) && value.length > 0)
    .map(([, value]) => value))];
}

async function directoryContainsAnyValue(
  directory: string,
  values: readonly Buffer[],
): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await directoryContainsAnyValue(path, values)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    const contents = await readFile(path);
    if (values.some((value) => contents.indexOf(value) >= 0)) return true;
  }
  return false;
}

export async function assertSensitiveValuesNotPersisted(input: {
  directory: string;
  diagnostics: unknown;
  values: readonly string[];
}): Promise<void> {
  const values = [...new Set(input.values.filter((value) => value.length > 0))];
  if (values.length === 0) return;
  const diagnostics = JSON.stringify(input.diagnostics) ?? '';
  if (
    values.some((value) => diagnostics.includes(value))
    || await directoryContainsAnyValue(
      input.directory,
      values.map((value) => Buffer.from(value)),
    )
  ) {
    throw new Error('A sensitive integration credential was persisted by the test workflow.');
  }
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
    openAiResponses: {
      requests: ReturnType<FakeOpenAiResponsesServer['diagnosticRequests']>;
      protocolViolations: ReturnType<FakeOpenAiResponsesServer['protocolViolations']>;
    };
    anthropic: {
      requests: ReturnType<FakeAnthropicServer['diagnosticRequests']>;
      protocolViolations: ReturnType<FakeAnthropicServer['protocolViolations']>;
    };
  };
}

function redactedErrorDetails(error: unknown): unknown {
  if (!(error instanceof Error)) return error === undefined ? null : '[REDACTED]';
  const stackFrames = error.stack
    ?.split('\n')
    .slice(1)
    .filter((line) => line.trimStart().startsWith('at '))
    .join('\n');
  return {
    name: error.name,
    message: '[REDACTED]',
    ...(stackFrames ? { stack: `[REDACTED]\n${stackFrames}` } : {}),
  };
}

function redactedFailure(error: unknown, artifact: string | null, diagnostics: string): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const stackFrames = original.stack
    ?.split('\n')
    .slice(1)
    .filter((line) => line.trimStart().startsWith('at '))
    .join('\n');
  const result = new Error([
    'Credential-backed integration test failed; sensitive failure content was redacted.',
    ...(artifact ? [`Integration diagnostics: ${artifact}`] : []),
    diagnostics,
  ].join('\n'));
  result.name = original.name;
  if (stackFrames) result.stack = `${result.name}: ${result.message}\n${stackFrames}`;
  return result;
}

export class IntegrationFixture {
  readonly dirs: IntegrationDirectories;
  readonly fakeProviders: {
    openAi: FakeOpenAiServer;
    openAiResponses: FakeOpenAiResponsesServer;
    anthropic: FakeAnthropicServer;
  };
  readonly directAgents: DirectTestAgents;
  readonly #forbiddenPersistedValues: readonly string[];
  readonly #redactSensitiveDiagnostics: boolean;
  readonly #serverEnvironment: Record<string, string>;
  readonly #workspaceName: string | undefined;
  readonly #afterGarconStop?: (directories: IntegrationDirectories) => Promise<void>;
  readonly #extraDiagnostics?: (directories: IntegrationDirectories) => Record<string, unknown>;
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
    forbiddenPersistedValues?: readonly string[];
    redactSensitiveDiagnostics?: boolean;
    serverEnvironment?: Record<string, string>;
    workspaceName?: string;
    afterGarconStop?: (directories: IntegrationDirectories) => Promise<void>;
    extraDiagnostics?: (directories: IntegrationDirectories) => Record<string, unknown>;
  }) {
    this.dirs = input.dirs;
    this.fakeProviders = input.fakeProviders;
    this.garcon = input.garcon;
    this.client = input.client;
    this.#clients.set('primary', input.client);
    this.directAgents = input.directAgents;
    this.#forbiddenPersistedValues = [...(input.forbiddenPersistedValues ?? [])];
    this.#redactSensitiveDiagnostics = input.redactSensitiveDiagnostics === true;
    this.#serverEnvironment = { ...(input.serverEnvironment ?? {}) };
    this.#workspaceName = input.workspaceName;
    this.#afterGarconStop = input.afterGarconStop;
    this.#extraDiagnostics = input.extraDiagnostics;
  }

  static async create(options: IntegrationFixtureOptions = {}): Promise<IntegrationFixture> {
    const root = await mkdtemp(join(tmpdir(), 'garcon-integration-'));
    const configDir = join(root, 'config');
    const dirs: IntegrationDirectories = {
      root,
      config: configDir,
      workspace: options.namedWorkspace
        ? join(configDir, `workspace-${options.namedWorkspace}`)
        : join(root, 'workspace'),
      project: join(root, 'project'),
      home: join(root, 'home'),
    };
    await Promise.all(Object.values(dirs).map((directory) => mkdir(directory, { recursive: true })));

    const fakeProviders = {
      openAi: FakeOpenAiServer.start(),
      openAiResponses: FakeOpenAiResponsesServer.start(),
      anthropic: FakeAnthropicServer.start(),
    };
    let garcon: GarconProcess | null = null;
    let client: GarconTestClient | null = null;
    try {
      // The resolver runs before prepareWorkspace so preparation can depend on derived paths;
      // the static record is spread afterwards because legacy tests mutate it during
      // preparation. Resolver values still win on conflicts.
      const resolvedEnvironment = options.resolveServerEnvironment?.(dirs) ?? {};
      await options.prepareWorkspace?.(dirs);
      const serverEnvironment = {
        ...(options.serverEnvironment ?? {}),
        ...resolvedEnvironment,
      };
      garcon = await GarconProcess.start({
        repoRoot: REPO_ROOT,
        configDir: dirs.config,
        workspaceDir: dirs.workspace,
        workspaceName: options.namedWorkspace,
        projectDir: dirs.project,
        homeDir: dirs.home,
        environment: serverEnvironment,
        redactEnvironmentValues: options.redactSensitiveDiagnostics,
      });
      client = await GarconTestClient.connect(garcon.baseUrl, {
        redactSensitiveDiagnostics: options.redactSensitiveDiagnostics,
      });
      await client.ping();
      const openAiProvider = await client.createOpenAiProvider(fakeProviders.openAi.baseUrl);
      const openAiResponsesProvider = await client.createOpenAiResponsesProvider(
        fakeProviders.openAiResponses.baseUrl,
      );
      const anthropicProvider = await client.createAnthropicProvider(fakeProviders.anthropic.baseUrl);
      const directAgents = {
        openAi: directAgent(
          DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
          openAiProvider,
        ),
        openAiResponses: directAgent(
          DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
          openAiResponsesProvider,
        ),
        anthropic: directAgent(
          DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
          anthropicProvider,
        ),
      } satisfies DirectTestAgents;
      const titleAgent = directAgents[options.chatTitleAgent ?? 'openAi'];
      const hasExplicitTitleAgent = options.chatTitleAgent !== undefined;
      await client.updateSettings({
        ui: {
          chatTitle: options.chatTitleEnabled || hasExplicitTitleAgent ? {
            enabled: options.chatTitleEnabled === true,
            agentId: titleAgent.agentId,
            model: titleAgent.provider.model,
            apiProviderId: titleAgent.provider.providerId,
            modelEndpointId: titleAgent.provider.endpointId,
            modelProtocol: titleAgent.provider.protocol,
            thinkingMode: 'none',
          } : { enabled: false },
        },
      });
      return new IntegrationFixture({
        dirs,
        fakeProviders,
        garcon,
        client,
        directAgents,
        forbiddenPersistedValues: options.forbiddenPersistedValues,
        redactSensitiveDiagnostics: options.redactSensitiveDiagnostics,
        serverEnvironment,
        workspaceName: options.namedWorkspace,
        afterGarconStop: options.afterGarconStop,
        extraDiagnostics: options.extraDiagnostics,
      });
    } catch (error) {
      await client?.close().catch(() => undefined);
      await garcon?.stop().catch(() => undefined);
      fakeProviders.openAi.stop();
      fakeProviders.openAiResponses.stop();
      fakeProviders.anthropic.stop();
      const cleanupError = await options.afterGarconStop?.(dirs).then(
        () => null,
        (hookError: unknown) => hookError,
      ) ?? null;
      if (!cleanupError) await rm(root, { recursive: true, force: true });
      if (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Integration fixture creation failed.');
      }
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
    const observer = await GarconTestClient.connect(this.garcon.baseUrl, {
      redactSensitiveDiagnostics: this.#redactSensitiveDiagnostics,
    });
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

  async crashAndRestartGarcon(options: {
    reusePort?: boolean;
    beforeStart?: () => Promise<void>;
  } = {}): Promise<void> {
    const previousPort = Number(new URL(this.garcon.baseUrl).port);
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
    await options.beforeStart?.();
    await this.#startReplacementGarcon(options.reusePort ? previousPort : undefined);
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

  async appendDirectOpenAiNativeMessage(input: {
    chatId: string;
    role: 'user' | 'assistant';
    content: string;
    clientRequestId?: string;
    turnId?: string;
  }): Promise<void> {
    const nativePath = await this.directOpenAiNativePath(input.chatId);
    const raw = await readFile(nativePath, 'utf8');
    if (raw.length > 0 && !raw.endsWith('\n')) {
      throw new Error('Direct native transcript has an incomplete tail.');
    }
    await appendFile(nativePath, `${JSON.stringify({
      role: input.role,
      content: input.content,
      timestamp: new Date().toISOString(),
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    })}\n`, 'utf8');
  }

  async directOpenAiNativePath(chatId: string): Promise<string> {
    const registry = JSON.parse(
      await readFile(join(this.dirs.workspace, 'chats.json'), 'utf8'),
    ) as { sessions?: Record<string, Record<string, unknown>> };
    const chat = registry.sessions?.[chatId];
    if (!chat) throw new Error(`Chat ${chatId} was not persisted before restart.`);
    if (chat.agentId !== DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID) {
      throw new Error(`Chat ${chatId} is not a direct OpenAI-compatible chat.`);
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
      throw new Error(`Chat ${chatId} has an unexpected native transcript path.`);
    }
    return expectedPath;
  }

  async #removeFinalNativeUserRow(input: { chatId: string; clientRequestId: string }): Promise<void> {
    const expectedPath = await this.directOpenAiNativePath(input.chatId);
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
        openAiResponses: {
          requests: this.fakeProviders.openAiResponses.diagnosticRequests(),
          protocolViolations: this.fakeProviders.openAiResponses.protocolViolations(),
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
      error: this.#redactSensitiveDiagnostics
        ? redactedErrorDetails(error)
        : error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error === undefined ? null : String(error),
      ...this.#diagnosticsForOutput(),
    }, null, 2));
    return path;
  }

  describe(): string {
    if (this.#redactSensitiveDiagnostics) {
      return JSON.stringify(this.#diagnosticsForOutput(), null, 2);
    }
    return [
      `Directories: ${JSON.stringify(this.dirs, null, 2)}`,
      `Process runs:\n${JSON.stringify(this.diagnostics().processRuns, null, 2)}`,
      `OpenAI requests:\n${this.fakeProviders.openAi.describeRequests()}`,
      `Responses requests:\n${this.fakeProviders.openAiResponses.describeRequests()}`,
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
      this.fakeProviders.openAiResponses.assertNoProtocolViolations();
      this.fakeProviders.anthropic.assertNoProtocolViolations();
      this.garcon.assertNoUnexpectedExit();
    } catch (error) {
      errors.push(error);
    }
    // Provider grandchildren are inspected and cleaned while the fixture root still exists.
    if (this.#afterGarconStop) {
      try {
        await this.#afterGarconStop(this.dirs);
      } catch (error) {
        errors.push(error);
      }
    }
    const forbiddenPersistedValues = [
      ...sensitiveEnvironmentValues(this.#serverEnvironment),
      ...this.#forbiddenPersistedValues,
    ];
    // Credential-backed fixtures verify that redaction never became on-disk persistence.
    if (forbiddenPersistedValues.length > 0) {
      try {
        await assertSensitiveValuesNotPersisted({
          directory: this.dirs.root,
          diagnostics: this.diagnostics(),
          values: forbiddenPersistedValues,
        });
      } catch (error) {
        errors.push(error);
      }
    }
    this.fakeProviders.openAi.stop();
    this.fakeProviders.openAiResponses.stop();
    this.fakeProviders.anthropic.stop();

    if (
      this.#redactSensitiveDiagnostics
      || (errors.length === 0 && process.env.KEEP_INTEGRATION_ARTIFACTS !== '1')
    ) {
      await rm(this.dirs.root, { recursive: true, force: true });
    }
    if (errors.length > 0) {
      if (this.#redactSensitiveDiagnostics) {
        throw new Error(`Integration fixture cleanup failed.\n${this.describe()}`);
      }
      throw new AggregateError(errors, `Integration fixture cleanup failed.\n${this.describe()}`);
    }
  }

  async #startReplacementGarcon(port?: number): Promise<void> {
    this.garcon = await GarconProcess.start({
      repoRoot: REPO_ROOT,
      configDir: this.dirs.config,
      workspaceDir: this.dirs.workspace,
      workspaceName: this.#workspaceName,
      projectDir: this.dirs.project,
      homeDir: this.dirs.home,
      environment: this.#serverEnvironment,
      redactEnvironmentValues: this.#redactSensitiveDiagnostics,
      port,
    });
    this.client = await GarconTestClient.connect(this.garcon.baseUrl, {
      redactSensitiveDiagnostics: this.#redactSensitiveDiagnostics,
    });
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

  #diagnosticsForOutput(): Record<string, unknown> {
    const diagnostics = this.diagnostics();
    if (!this.#redactSensitiveDiagnostics) {
      return {
        ...diagnostics as unknown as Record<string, unknown>,
        extensions: this.#safeExtraDiagnostics(),
      };
    }
    return {
      directories: '[REDACTED]',
      processRuns: diagnostics.processRuns.map((run) => ({
        serverLogLineCount: run.serverLogs.length,
        clients: run.clients,
      })),
      providers: Object.fromEntries(
        Object.entries(diagnostics.providers).map(([name, provider]) => [
          name,
          {
            requestCount: provider.requests.length,
            protocolViolationCount: provider.protocolViolations.length,
          },
        ]),
      ),
    };
  }

  // Callback failures are recorded instead of masking the original test failure.
  #safeExtraDiagnostics(): Record<string, unknown> | null {
    if (!this.#extraDiagnostics) return null;
    try {
      return this.#extraDiagnostics(this.dirs);
    } catch (error) {
      return { diagnosticError: error instanceof Error ? error.message : String(error) };
    }
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
    if (options.redactSensitiveDiagnostics) {
      throw redactedFailure(error, artifact, fixture.describe());
    }
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
