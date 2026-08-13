import os from 'node:os';
import { stat } from 'node:fs/promises';
import { PERMISSION_MODE_VALUES, THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { CHAT_FILE_ATTACHMENT_MIME_TYPES } from '@garcon/common/attachments';
import { CODEX_MODELS } from '@garcon/common/models';
import { retargetNativeSeedReceipt } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  type AgentNativeForkRequest,
  type AgentHost,
  type AgentIntegration,
} from '@garcon/server-agent-interface';
import { CliLoginController } from '@garcon/server-agent-common/auth/cli-login-controller';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { resolveAgentEndpoint } from '@garcon/server-agent-common/execution/resolve-endpoint';
import { createJsonlNativeForking } from '@garcon/server-agent-common/forking/jsonl-forking';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { createScopedAgentLogger } from '@garcon/server-agent-common/logging/scoped-agent-logger';
import { createVersion1RecordMigration } from '@garcon/server-agent-common/migration/version-1-record-migration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { singleQueryRuntimeOptions } from '@garcon/server-agent-common/shared/single-query-control';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import { createNativeHistoryImport } from '@garcon/server-agent-common/native-session/native-history-import';
import { createCodexConfig, type CodexConfig } from './config.js';
import { getCodexAuthStatus } from './agents/codex/codex-auth.js';
import { CodexExecution } from './agents/codex/execution.js';
import { createCodexForkTranscriptRewriter } from './agents/codex/fork-transcript.js';
import {
  createCodexForking,
  isCodexThreadNotFound,
} from './agents/codex/codex-forking.js';
import { createCodexForkTargetPath } from './agents/codex/fork-target-path.js';
import { inspectCodexHistoryProfile } from './agents/codex/history-profile.js';
import { createCodexNativeEvidence } from './agents/codex/transcript.js';
import {
  buildCodexAppServerEndpointRuntime,
  buildCodexHostEnvironment,
} from './agents/codex/app-server/endpoint-runtime.js';
import { CodexAppServerClient } from './agents/codex/app-server/client.js';
import { CodexAppServerRuntime } from './agents/codex/app-server/runtime.js';
import { runSingleQuery } from './agents/codex/app-server/run-single-query.js';
import { CodexSkillDiscovery } from './agents/codex/slash-command-discovery.js';
import { createCodexNativeActivityProbe } from './agents/codex/native-activity.js';

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
  static readonly apiVersion = 5 as const;
  readonly descriptor = CODEX_DESCRIPTOR;
  readonly attachments = {
    fileMimeTypes: CHAT_FILE_ATTACHMENT_MIME_TYPES,
  } as const;
  readonly execution;
  readonly nativeHistoryImport;
  readonly nativeActivity;
  readonly nativeSessions;
  readonly sessionConfiguration: NonNullable<AgentIntegration['sessionConfiguration']>;
  readonly permissionDecisions: NonNullable<AgentIntegration['permissionDecisions']>;
  readonly projectPathUpdates = null;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth: NonNullable<AgentIntegration['auth']>;
  readonly commands: NonNullable<AgentIntegration['commands']>;
  readonly compaction: NonNullable<AgentIntegration['compaction']>;
  readonly forking;
  readonly steering: NonNullable<AgentIntegration['steering']>;
  readonly goals: NonNullable<AgentIntegration['goals']>;
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
    const execution = new CodexExecution(host, runtime, nativeSessions, config);
    this.sessionConfiguration = {
      apply: (agentSessionId, configuration) => (
        execution.applySessionConfiguration(agentSessionId, configuration)
      ),
    };
    this.permissionDecisions = {
      respond: (permissionRequestId, decision) => (
        execution.respondToPermission(permissionRequestId, decision)
      ),
    };
    const nativeEvidence = createCodexNativeEvidence(runtime, nativeSessions, logger);
    this.nativeSessions = nativeEvidence;
    const producer = createAgentProducerAdapter(execution);
    this.execution = producer.execution;
    this.nativeHistoryImport = createNativeHistoryImport(nativeEvidence);
    this.nativeActivity = createCodexNativeActivityProbe(nativeSessions);
    // Codex compacts natively through its app-server; the execution object owns
    // the call, the facet advertises that it exists.
    this.compaction = {
      compact: async (request) => (
        await producer.runExisting(request, (runtimeRequest) => execution.compact(runtimeRequest))
      ).handle,
    };
    this.steering = {
      captureTarget: (request) => runtime.captureSteerTarget(request.agentSessionId),
      steer: (request) => runtime.steer(request),
    };
    this.goals = {
      submitControl: async (request) => (
        await producer.runExisting(
          request,
          (runtimeRequest) => execution.submitGoalControl(runtimeRequest),
        )
      ).value,
    };
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
    const journalForking = createJsonlNativeForking({
      nativeEvidence,
      nativeSessions,
      createTargetPath: createCodexForkTargetPath,
      createRewriteEntry: createCodexForkTranscriptRewriter,
      allowUnmaterializedWholeSession: true,
      forkWholeSession: (request) => forkWholeCodexSession(
        request,
        host,
        runtime,
        nativeSessions,
        config,
      ),
    });
    this.forking = createCodexForking({
      journal: journalForking,
      resolveProfile: async (request) => {
        let reference = request.source.nativeSession;
        let source = nativeSessions.decode(reference);
        if (!source.path) {
          reference = await nativeEvidence.resolveNativeSession({
            chat: request.source,
            signal: request.signal,
          });
          source = nativeSessions.decode(reference);
        }
        if (!source.path) {
          if (!request.point) return null;
          throw transcriptUnavailableForFork();
        }
        if (!await codexRolloutHasContent(source.path)) {
          if (!request.point) return null;
          throw transcriptUnavailableForFork();
        }
        return inspectCodexHistoryProfile({
          nativePath: source.path,
          expectedThreadId: request.source.agentSessionId ?? source.agentSessionId,
          signal: request.signal,
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
        await runtime.shutdown();
        login.stop();
        await skillDiscovery.clear();
      },
    });
  }
}

async function forkWholeCodexSession(
  request: AgentNativeForkRequest,
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
  if (source.path && !await codexRolloutHasContent(source.path)) return null;
  let result;
  try {
    result = await runtime.forkSession({
      sourceSession: {
        projectPath: request.source.projectPath,
        model: request.source.model,
        agentSessionId: request.source.agentSessionId ?? source.agentSessionId,
        nativePath: source.path,
      },
      envOverrides: buildCodexHostEnvironment(config),
      codexConfig: endpointRuntime?.codexConfig,
    });
  } catch (error) {
    // A never-persisted thread cannot fork natively; the JSONL path resolves it
    // to an unmaterialized child without weakening any other app-server failure.
    if (isCodexThreadNotFound(error)) return null;
    throw error;
  }
  if (!result) return null;
  return {
    agentSessionId: result.agentSessionId,
    nativeSession: nativeSessions.encode({
      path: result.nativePath,
      agentSessionId: result.agentSessionId,
      modelEndpointId: request.endpoint?.endpointId ?? source.modelEndpointId,
    }),
    nativeSeedReceipt: retargetNativeSeedReceipt(
      request.source.nativeSeedReceipt,
      result.agentSessionId,
    ),
  };
}

async function codexRolloutHasContent(nativePath: string): Promise<boolean> {
  try {
    return (await stat(nativePath)).size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function transcriptUnavailableForFork(): AgentIntegrationError {
  return new AgentIntegrationError(
    'TRANSCRIPT_UNAVAILABLE',
    'Source native transcript is unavailable',
    false,
  );
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
