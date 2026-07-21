import os from 'node:os';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { CODEX_MODELS } from '@garcon/common/models';
import {
  AgentIntegrationError,
  computeAgentTranscriptRevision,
  type AgentForkRequest,
  type AgentHost,
  type AgentIntegration,
  type AgentTranscript,
} from '@garcon/server-agent-interface';
import { CliLoginController } from '@garcon/server-agent-common/auth/cli-login-controller';
import { resolveAgentStandaloneEntrypoint } from '@garcon/server-agent-common/build/standalone-entrypoint';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { resolveAgentEndpoint } from '@garcon/server-agent-common/execution/resolve-endpoint';
import { createJsonlForking } from '@garcon/server-agent-common/forking/jsonl-forking';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createCodexConfig, type CodexConfig } from './config.js';
import { getCodexAuthStatus } from './agents/codex/codex-auth.js';
import { CodexExecution } from './agents/codex/execution.js';
import { createCodexForkTranscriptRewriter } from './agents/codex/fork-transcript.js';
import { createCodexForking } from './agents/codex/codex-forking.js';
import { inspectCodexHistoryProfile } from './agents/codex/history-profile.js';
import {
  buildCodexAppServerEndpointRuntime,
  buildCodexHostEnvironment,
} from './agents/codex/app-server/endpoint-runtime.js';
import { CodexAppServerClient } from './agents/codex/app-server/client.js';
import { CodexAppServerRuntime } from './agents/codex/app-server/runtime.js';
import { runSingleQuery } from './agents/codex/app-server/run-single-query.js';
import { CodexSkillDiscovery } from './agents/codex/slash-command-discovery.js';

const CODEX_DESCRIPTOR = {
  id: 'codex',
  label: 'Codex',
  icon: null,
  supportedPermissionModes: PERMISSION_MODE_VALUES.filter((mode) => mode !== 'plan'),
  supportedThinkingModes: THINKING_MODE_VALUES,
  supportsImages: true,
  supportsProjectPathUpdate: true,
  requiresNativePathForProjectPathUpdate: false,
  supportedEndpointProtocols: ['openai-compatible'],
  configuration: [
    { key: 'OPENAI_API_KEY', source: 'environment', description: 'OpenAI API key.' },
    { key: 'OPENAI_BASE_URL', source: 'environment', description: 'OpenAI API base URL.' },
    { key: 'CODEX_HOME', source: 'environment', description: 'Codex state directory.' },
    { key: 'npm_package_version', source: 'environment', description: 'Garcon package version.' },
  ],
} as const;

export default class CodexAgentIntegration implements AgentIntegration {
  static readonly integrationId = 'codex';
  static readonly apiVersion = 2 as const;
  static readonly transcriptIndex = {
    apiVersion: 1,
    moduleUrl: resolveAgentStandaloneEntrypoint({
      integrationId: 'codex',
      name: 'transcript-index-source',
      sourceUrl: new URL('./transcript-index-source.ts', import.meta.url),
    }),
  } as const;

  readonly descriptor = CODEX_DESCRIPTOR;
  readonly execution;
  readonly transcript;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegration['auth']>;
  readonly commands: NonNullable<AgentIntegration['commands']>;
  readonly forking;
  readonly endpoints: NonNullable<AgentIntegration['endpoints']>;
  readonly singleQuery: NonNullable<AgentIntegration['singleQuery']>;

  constructor(host: AgentHost) {
    const config = createCodexConfig(host.environment);
    const logger = createScopedAgentLogger(host.logger, 'codex');
    const nativeSessions = createPathNativeSessionCodec('codex');
    const createClient = (options: ConstructorParameters<typeof CodexAppServerClient>[0] = {}) => (
      new CodexAppServerClient({
        ...options,
        env: { ...buildCodexHostEnvironment(config), ...options.env },
        clientVersion: config.packageVersion,
      })
    );
    const skillDiscovery = new CodexSkillDiscovery({
      createClient: () => createClient(),
      logger,
    });
    const runtime = new CodexAppServerRuntime({
      createClient,
      logger,
      skillDiscovery,
    });
    const login = new CliLoginController({
      command: () => ['codex', 'login', '--device-auth'],
      mode: 'device-code',
      logger,
      cwd: os.homedir(),
      environment: () => codexLoginEnvironment(config),
      spawnPty: spawnCodexLoginPty,
    });

    this.settings = createVersionedSettings({
      ownerId: 'codex',
      schemaVersion: 1,
      defaults: {},
      descriptors: [],
    });
    this.execution = new CodexExecution(host, runtime, nativeSessions, config);
    this.transcript = createCodexTranscript(runtime, nativeSessions, config);
    this.catalog = createModelCatalog({
      logger: host.logger,
      defaultModel: CODEX_MODELS.DEFAULT,
      fallbackModels: CODEX_MODELS.OPTIONS,
      requiresStrictModelDiscovery: false,
      generation: { priority: 30, model: CODEX_MODELS.DEFAULT },
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    this.auth = {
      async status(signal) {
        signal.throwIfAborted();
        const status = await getCodexAuthStatus(config);
        return {
          authenticated: status.authenticated,
          canReauth: true,
          label: status.label || 'Codex',
          source: status.authenticated ? 'cli' : 'none',
        };
      },
      launchLogin: () => login.launch(),
      loginStatus: (expectedSessionId) => login.status(expectedSessionId),
    };
    this.commands = {
      discover: (projectPath, signal) => {
        signal.throwIfAborted();
        return skillDiscovery.commands(projectPath);
      },
    };
    const legacyForking = createJsonlForking({
      host,
      supportsWhileRunning: true,
      transcript: this.transcript,
      nativeSessions,
      createRewriteEntry: createCodexForkTranscriptRewriter,
      forkWholeSession: (request) => forkWholeCodexSession(
        request,
        host,
        runtime,
        nativeSessions,
        config,
      ),
    });
    this.forking = createCodexForking({
      legacy: legacyForking,
      resolveProfile: async (request) => {
        let reference = request.source.nativeSession;
        let source = nativeSessions.decode(reference);
        if (!source.path) {
          reference = await this.transcript.resolveNativeSession({
            chat: request.source,
            signal: request.admission.signal,
          });
          source = nativeSessions.decode(reference);
        }
        if (!source.path) {
          throw new AgentIntegrationError(
            'TRANSCRIPT_UNAVAILABLE',
            'Source native transcript is unavailable',
            false,
          );
        }
        return inspectCodexHistoryProfile({
          nativePath: source.path,
          expectedThreadId: request.source.agentSessionId ?? source.agentSessionId,
          signal: request.admission.signal,
        });
      },
      forkPaginatedWhole: (request) => forkWholeCodexSession(
        request,
        host,
        runtime,
        nativeSessions,
        config,
      ),
    });
    this.endpoints = {
      async validate(selection) {
        if (selection.protocol !== 'openai-compatible') {
          throw new AgentIntegrationError(
            'INVALID_ENDPOINT',
            'Codex requires an OpenAI-compatible endpoint',
            false,
          );
        }
        if (selection.capabilities?.responses !== true) {
          throw new AgentIntegrationError(
            'INVALID_ENDPOINT',
            'Codex requires an endpoint with the OpenAI Responses API',
            false,
          );
        }
      },
    };
    this.singleQuery = {
      async run(request) {
        const resolved = await resolveAgentEndpoint(host, request.endpoint, request.signal);
        const endpointRuntime = resolved
          ? buildCodexAppServerEndpointRuntime(resolved)
          : null;
        if (resolved && !endpointRuntime) {
          throw new AgentIntegrationError(
            'INVALID_ENDPOINT',
            'Codex requires an OpenAI-compatible endpoint',
            false,
          );
        }
        try {
          return await runSingleQuery(request.prompt, {
            projectPath: request.projectPath,
            model: request.model,
            ...singleQueryRuntimeOptions(request),
            permissionMode: 'default',
            envOverrides: buildCodexHostEnvironment(config),
            codexConfig: endpointRuntime?.codexConfig,
          });
        } catch (error) {
          throw classifyCodexError(error);
        }
      },
    };
    this.lifecycle = createIntegrationLifecycle({
      start: () => runtime.startPurgeTimer(),
      stop: async () => {
        runtime.shutdown();
        login.stop();
        skillDiscovery.clear();
      },
    });
  }
}

function createCodexTranscript(
  runtime: CodexAppServerRuntime,
  nativeSessions: ReturnType<typeof createPathNativeSessionCodec>,
  config: CodexConfig,
): AgentTranscript {
  const reference = (chat: Parameters<AgentTranscript['load']>[0]['chat']) => {
    const native = nativeSessions.decode(chat.nativeSession);
    return {
      projectPath: chat.projectPath,
      model: chat.model,
      agentSessionId: chat.agentSessionId ?? native.agentSessionId,
      nativePath: native.path,
    };
  };
  const loadMessages = (
    chat: Parameters<AgentTranscript['load']>[0]['chat'],
    signal: AbortSignal,
  ) => (
    runtime.loadMessages(reference(chat), signal)
  );
  const resolvePath = async (chat: Parameters<AgentTranscript['load']>[0]['chat']) => {
    const value = reference(chat);
    return value.nativePath ?? runtime.resolveNativePath(value);
  };
  const resolveIndexSource = async (
    chat: Parameters<AgentTranscript['load']>[0]['chat'],
    signal: AbortSignal,
  ) => {
    const nativePath = await resolvePath(chat);
    if (!nativePath) return null;
    const value = reference(chat);
    const profile = await inspectCodexHistoryProfile({
      nativePath,
      expectedThreadId: value.agentSessionId,
      signal,
    });
    return {
      ownerId: 'codex',
      schemaVersion: 2,
      value: {
        nativePath,
        threadId: profile.threadId,
        historyMode: profile.mode,
        codexHome: config.home(),
      },
    } as const;
  };
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const current = nativeSessions.decode(chat.nativeSession);
      const agentSessionId = chat.agentSessionId ?? current.agentSessionId;
      if (!agentSessionId) return null;
      const nativePath = await runtime.resolveNativePath(reference(chat));
      return nativeSessions.encode({
        path: nativePath,
        agentSessionId,
        modelEndpointId: current.modelEndpointId,
      });
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      const messages = await loadMessages(chat, signal);
      return { messages, revision: computeAgentTranscriptRevision(messages) };
    },
    async loadPage({ chat, page, signal }) {
      signal.throwIfAborted();
      return runtime.loadMessagePage(reference(chat), page, signal);
    },
    async preview({ chat, signal }) {
      signal.throwIfAborted();
      return normalizeCodexPreview(await runtime.getPreview(reference(chat), signal));
    },
    async revision({ chat, signal }) {
      signal.throwIfAborted();
      return computeAgentTranscriptRevision(await loadMessages(chat, signal));
    },
    async resolveIndexSource({ chat, signal }) {
      signal.throwIfAborted();
      return resolveIndexSource(chat, signal);
    },
    async refreshIndexSource({ chat, signal }) {
      signal.throwIfAborted();
      return resolveIndexSource(chat, signal);
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const nativePath = await resolvePath(chat);
      return nativePath ? { kind: 'filesystem-path', value: nativePath } : null;
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}

async function forkWholeCodexSession(
  request: AgentForkRequest,
  host: AgentHost,
  runtime: CodexAppServerRuntime,
  nativeSessions: ReturnType<typeof createPathNativeSessionCodec>,
  config: CodexConfig,
) {
  const source = nativeSessions.decode(request.source.nativeSession);
  const endpoint = await resolveAgentEndpoint(host, request.endpoint, request.admission.signal);
  const endpointRuntime = endpoint ? buildCodexAppServerEndpointRuntime(endpoint) : null;
  if (endpoint && !endpointRuntime) {
    throw new AgentIntegrationError(
      'INVALID_ENDPOINT',
      'Codex requires an OpenAI-compatible endpoint',
      false,
    );
  }
  const result = await runtime.forkSession({
    sourceSession: {
      projectPath: request.source.projectPath,
      model: request.source.model,
      agentSessionId: request.source.agentSessionId ?? source.agentSessionId,
      nativePath: source.path,
    },
    envOverrides: buildCodexHostEnvironment(config),
    codexConfig: endpointRuntime?.codexConfig,
  });
  if (!result) return null;
  return {
    agentSessionId: result.agentSessionId,
    nativeSession: nativeSessions.encode({
      path: result.nativePath,
      agentSessionId: result.agentSessionId,
      modelEndpointId: request.endpoint?.endpointId ?? source.modelEndpointId,
    }),
  };
}

function normalizeCodexPreview(value: unknown) {
  const preview = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!preview || typeof preview.firstMessage !== 'string') return null;
  return {
    firstMessage: preview.firstMessage,
    lastMessage: typeof preview.lastMessage === 'string'
      ? preview.lastMessage
      : preview.firstMessage,
    createdAt: typeof preview.createdAt === 'string' ? preview.createdAt : null,
    lastActivity: typeof preview.lastActivity === 'string' ? preview.lastActivity : null,
  };
}

async function spawnCodexLoginPty(
  command: readonly [string, ...string[]],
  options: { readonly cwd: string; readonly env: Record<string, string> },
) {
  const { spawn } = await import('bun-pty');
  const [binary, ...args] = command;
  return spawn(binary, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: options.cwd,
    env: options.env,
  });
}

function codexLoginEnvironment(config: CodexConfig): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    ...buildCodexHostEnvironment(config),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
  };
}

function classifyCodexError(error: unknown): AgentIntegrationError {
  if (error instanceof AgentIntegrationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const code = normalized.includes('auth') || normalized.includes('login')
    ? 'AUTH_REQUIRED'
    : normalized.includes('rate limit') || normalized.includes('429')
      ? 'RATE_LIMITED'
      : normalized.includes('timeout') || normalized.includes('timed out')
        ? 'TIMEOUT'
        : 'PROVIDER_FAILURE';
  return new AgentIntegrationError(code, message, code !== 'AUTH_REQUIRED');
}
