import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { CLAUDE_MODELS } from '@garcon/common/models';
import {
  AgentIntegrationError,
  computeAgentTranscriptRevision,
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
import { createClaudeConfig } from './config.js';
import { getClaudeAuthStatus } from './agents/claude/claude-auth.js';
import {
  ClaudeCliRuntime,
  runSingleQuery,
} from './agents/claude/claude-cli.js';
import { ClaudeCliVersionProbe } from './agents/claude/cli-version.js';
import {
  buildClaudeEndpointRuntime,
  buildClaudeHostEnvironment,
} from './agents/claude/endpoint-runtime.js';
import { ClaudeExecution } from './agents/claude/execution.js';
import {
  claudeForkSemanticDigest,
  projectClaudeForkEntry,
  transformClaudeForkTranscript,
} from './agents/claude/fork-transcript.js';
import {
  getClaudePreviewFromNativePath,
  loadClaudeChatMessagePage,
  loadClaudeChatMessages,
} from './agents/claude/history-loader.js';
import {
  createClaudeNativePath,
  resolveClaudeNativePath,
} from './agents/claude/native-path.js';
import { ClaudeSlashCommandDiscovery } from './agents/claude/slash-command-discovery.js';

const CLAUDE_DESCRIPTOR = {
  id: 'claude',
  label: 'Claude',
  icon: null,
  supportedPermissionModes: PERMISSION_MODE_VALUES,
  supportedThinkingModes: THINKING_MODE_VALUES,
  supportsImages: true,
  supportsProjectPathUpdate: true,
  requiresNativePathForProjectPathUpdate: false,
  supportedEndpointProtocols: ['anthropic-messages'],
  configuration: [
    { key: 'CLAUDE_BINARY', source: 'environment', description: 'Claude CLI binary.' },
    { key: 'ANTHROPIC_API_KEY', source: 'environment', description: 'Anthropic API key.' },
    { key: 'ANTHROPIC_BASE_URL', source: 'environment', description: 'Anthropic API base URL.' },
    { key: 'CLAUDE_CONFIG_DIR', source: 'environment', description: 'Claude configuration directory.' },
  ],
} as const;

export default class ClaudeAgentIntegration implements AgentIntegration {
  static readonly integrationId = 'claude';
  static readonly apiVersion = 2 as const;
  static readonly transcriptIndex = {
    apiVersion: 1,
    moduleUrl: resolveAgentStandaloneEntrypoint({
      integrationId: 'claude',
      name: 'transcript-index-source',
      sourceUrl: new URL('./transcript-index-source.ts', import.meta.url),
    }),
  } as const;

  readonly descriptor = CLAUDE_DESCRIPTOR;
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
    const config = createClaudeConfig(host.environment);
    const logger = createScopedAgentLogger(host.logger, 'claude');
    const nativeSessions = createPathNativeSessionCodec('claude');
    const versionProbe = new ClaudeCliVersionProbe(logger);
    const runtime = new ClaudeCliRuntime({
      binary: config.binary,
      logger,
      versionProbe,
    });
    const login = new CliLoginController({
      command: () => [config.binary(), 'auth', 'login'],
      mode: 'browser-code',
      logger,
      environment: () => claudeLoginEnvironment(config),
    });
    const commandDiscovery = new ClaudeSlashCommandDiscovery(config.binary, logger);

    this.settings = createVersionedSettings({
      ownerId: 'claude',
      schemaVersion: 1,
      defaults: { claudeThinkingMode: 'auto' },
      descriptors: [{
        key: 'claudeThinkingMode',
        type: 'enum',
        label: 'Thinking',
        labelKey: 'thinking',
        options: [
          {
            value: 'auto',
            label: 'Auto',
            labelKey: 'automatic',
            description: 'Lets Claude decide when extended thinking is useful.',
            descriptionKey: 'thinkingAutomatic',
          },
          {
            value: 'on',
            label: 'On',
            labelKey: 'enabled',
            description: 'Uses extended thinking for every response.',
            descriptionKey: 'thinkingEnabled',
          },
          {
            value: 'off',
            label: 'Off',
            labelKey: 'disabled',
            description: 'Answers without extended thinking.',
            descriptionKey: 'thinkingDisabled',
          },
        ],
      }],
    });
    this.execution = new ClaudeExecution(
      host,
      runtime,
      nativeSessions,
      logger,
      config,
    );
    this.transcript = createClaudeTranscript({
      nativeSessions,
      configHomeDir: config.configHomeDir,
      logger,
    });
    this.catalog = createModelCatalog({
      logger: host.logger,
      defaultModel: CLAUDE_MODELS.DEFAULT,
      fallbackModels: CLAUDE_MODELS.OPTIONS,
      requiresStrictModelDiscovery: false,
      generation: { priority: 10, model: 'haiku' },
    });
    this.migration = createVersion1RecordMigration({ settings: this.settings, nativeSessions });
    this.auth = {
      async status(signal) {
        signal.throwIfAborted();
        const status = await getClaudeAuthStatus(config);
        return {
          authenticated: status.authenticated,
          canReauth: true,
          label: status.label || 'Claude',
          source: status.authenticated ? 'cli' : 'none',
        };
      },
      launchLogin: () => login.launch(),
      completeLogin: (sessionId, code) => login.complete(sessionId, code),
      loginStatus: (expectedSessionId) => login.status(expectedSessionId),
    };
    this.commands = {
      discover: (projectPath, signal) => {
        signal.throwIfAborted();
        return commandDiscovery.discover(projectPath);
      },
    };
    this.forking = createJsonlForking({
      host,
      supportsAtMessageWhileRunning: true,
      transcript: this.transcript,
      nativeSessions,
      rewriteEntry: projectClaudeForkEntry,
      transformEntries: transformClaudeForkTranscript,
      semanticDigest: claudeForkSemanticDigest,
    });
    this.endpoints = {
      async validate(selection) {
        if (selection.protocol !== 'anthropic-messages') {
          throw new AgentIntegrationError(
            'INVALID_ENDPOINT',
            'Claude requires an Anthropic Messages endpoint',
            false,
          );
        }
      },
    };
    this.singleQuery = {
      async run(request) {
        const resolved = await resolveAgentEndpoint(host, request.endpoint, request.signal);
        const endpointRuntime = resolved ? buildClaudeEndpointRuntime(resolved) : null;
        if (resolved && !endpointRuntime) {
          throw new AgentIntegrationError(
            'INVALID_ENDPOINT',
            'Claude requires an Anthropic Messages endpoint',
            false,
          );
        }
        try {
          return await runSingleQuery(request.prompt, {
            cwd: request.projectPath,
            model: request.model,
            ...singleQueryRuntimeOptions(request),
            envOverrides: {
              ...buildClaudeHostEnvironment(config),
              ...endpointRuntime?.envOverrides,
            },
          }, { binary: config.binary, logger, versionProbe });
        } catch (error) {
          throw classifyClaudeError(error);
        }
      },
    };
    this.lifecycle = createIntegrationLifecycle({
      start: () => runtime.startPurgeTimer(),
      stop: async () => {
        runtime.shutdown();
        login.stop();
        commandDiscovery.clear();
      },
    });
  }
}

function createClaudeTranscript(options: {
  readonly nativeSessions: ReturnType<typeof createPathNativeSessionCodec>;
  readonly configHomeDir: () => string | null;
  readonly logger: AgentHost['logger'];
}): AgentTranscript {
  const reference = (chat: Parameters<AgentTranscript['load']>[0]['chat']) => {
    const native = options.nativeSessions.decode(chat.nativeSession);
    return {
      projectPath: chat.projectPath,
      agentSessionId: chat.agentSessionId ?? native.agentSessionId,
      nativePath: native.path,
    };
  };
  const derivedPath = async (chat: Parameters<AgentTranscript['load']>[0]['chat']) => {
    const value = reference(chat);
    return value.nativePath ?? (value.agentSessionId
      ? createClaudeNativePath(chat.projectPath, value.agentSessionId, {
          configHomeDir: options.configHomeDir() ?? undefined,
          logger: options.logger,
        })
      : null);
  };
  const loadMessages = async (chat: Parameters<AgentTranscript['load']>[0]['chat']) => (
    loadClaudeChatMessages(await derivedPath(chat), options.logger)
  );
  const resolveIndexSource = async (
    chat: Parameters<AgentTranscript['load']>[0]['chat'],
  ) => {
    const nativePath = await derivedPath(chat);
    return nativePath ? {
      ownerId: 'claude',
      schemaVersion: 1,
      value: { nativePath },
    } as const : null;
  };
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const current = options.nativeSessions.decode(chat.nativeSession);
      const agentSessionId = chat.agentSessionId ?? current.agentSessionId;
      if (!agentSessionId) return null;
      const nativePath = await resolveClaudeNativePath(reference(chat), {
        configHomeDir: options.configHomeDir() ?? undefined,
        logger: options.logger,
      });
      return options.nativeSessions.encode({
        path: nativePath,
        agentSessionId,
        modelEndpointId: current.modelEndpointId,
      });
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      const messages = await loadMessages(chat);
      return { messages, revision: computeAgentTranscriptRevision(messages) };
    },
    async loadPage({ chat, page, signal }) {
      signal.throwIfAborted();
      return loadClaudeChatMessagePage(
        await derivedPath(chat),
        page.limit,
        page.offset,
        options.logger,
      );
    },
    async preview({ chat, signal }) {
      signal.throwIfAborted();
      const nativePath = await derivedPath(chat);
      if (!nativePath) return null;
      const preview = await getClaudePreviewFromNativePath(nativePath, options.logger);
      if (!preview) return null;
      return {
        firstMessage: preview.firstMessage,
        lastMessage: preview.lastMessage,
        createdAt: typeof preview.createdAt === 'string' ? preview.createdAt : null,
        lastActivity: preview.lastActivity,
      };
    },
    async revision({ chat, signal }) {
      signal.throwIfAborted();
      return computeAgentTranscriptRevision(await loadMessages(chat));
    },
    async resolveIndexSource({ chat, signal }) {
      signal.throwIfAborted();
      return resolveIndexSource(chat);
    },
    async refreshIndexSource({ chat, signal }) {
      signal.throwIfAborted();
      return resolveIndexSource(chat);
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const nativePath = await derivedPath(chat);
      return nativePath ? { kind: 'filesystem-path', value: nativePath } : null;
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}

function claudeLoginEnvironment(config: ReturnType<typeof createClaudeConfig>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CLAUDECODE') environment[key] = value;
  }
  return {
    ...environment,
    ...buildClaudeHostEnvironment(config),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
  };
}

function classifyClaudeError(error: unknown): AgentIntegrationError {
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
