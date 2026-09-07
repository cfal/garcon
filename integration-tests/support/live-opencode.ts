import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type {
  AgentRunCommandRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.js';
import type { IntegrationFixtureOptions } from './integration-fixture.js';
import {
  OPENCODE_BINARY,
  OPENCODE_VERSION,
  openCodePaths,
  terminateOrphanedOpenCodeSupervisors,
  writeOpenCodePluginSeed,
  writeOpenCodeSupervisorShim,
} from './scripted-opencode.js';
import {
  verifyPinnedBinaryVersion,
  writeJsonAtomic,
  type OpenCodeBinaryVerification,
} from './opencode-process-supervisor.js';

export const LIVE_OPENCODE_THINKING_MODE = 'none';

// Testing credentials are named for the model provider whose quota they spend,
// so the same secret drives every agent lane that bills that provider.
export interface LiveOpenCodeProvider {
  readonly providerId: string;
  readonly model: string;
  readonly keyEnv: string;
  readonly testingKeyEnv: string;
}

const LIVE_OPENCODE_PROVIDERS: Record<string, LiveOpenCodeProvider> = {
  deepseek: {
    providerId: 'deepseek',
    model: 'deepseek/deepseek-v4-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
    testingKeyEnv: 'DEEPSEEK_TESTING_KEY',
  },
  openai: {
    providerId: 'openai',
    model: 'openai/gpt-5.4-nano',
    keyEnv: 'OPENAI_API_KEY',
    testingKeyEnv: 'OPENAI_TESTING_KEY',
  },
};

export function liveOpenCodeProvider(): LiveOpenCodeProvider {
  const requested = process.env.OPENCODE_TESTING_PROVIDER?.trim() || 'deepseek';
  const provider = LIVE_OPENCODE_PROVIDERS[requested];
  if (!provider) {
    throw new Error(
      `Unsupported OPENCODE_TESTING_PROVIDER "${requested}"; expected one of: ${
        Object.keys(LIVE_OPENCODE_PROVIDERS).join(', ')
      }.`,
    );
  }
  const model = process.env.OPENCODE_TESTING_MODEL?.trim();
  return model ? { ...provider, model } : provider;
}

const OPENCODE_AGENT_SETTINGS: AgentSettingsEnvelope = {
  ownerId: 'opencode',
  schemaVersion: 1,
  values: {},
};
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function requiredTestingKey(provider: LiveOpenCodeProvider): string {
  const key = process.env[provider.testingKeyEnv]?.trim();
  if (!key) {
    throw new Error(
      `${provider.testingKeyEnv} is required for live OpenCode integration tests against ${provider.providerId}.`,
    );
  }
  return key;
}

function liveOpenCodeConfig(provider: LiveOpenCodeProvider): Record<string, unknown> {
  return {
    formatter: false,
    lsp: false,
    enabled_providers: [provider.providerId],
    model: provider.model,
    small_model: provider.model,
    agent: {
      title: { disable: true },
      summary: { disable: true },
    },
  };
}

export async function liveOpenCodeFixtureOptions(): Promise<IntegrationFixtureOptions> {
  const provider = liveOpenCodeProvider();
  const testingKey = requiredTestingKey(provider);
  await access(OPENCODE_BINARY, constants.X_OK);

  return {
    forbiddenPersistedValues: [testingKey],
    redactSensitiveDiagnostics: true,
    resolveServerEnvironment(directories) {
      const paths = openCodePaths(directories);
      return {
        HOME: directories.home,
        XDG_CONFIG_HOME: paths.xdgConfig,
        XDG_DATA_HOME: paths.xdgData,
        XDG_STATE_HOME: paths.xdgState,
        XDG_CACHE_HOME: paths.xdgCache,
        TMPDIR: paths.temp,
        OPENCODE_AUTH_CONTENT: '{}',
        OPENCODE_CONFIG: paths.config,
        OPENCODE_DB: paths.database,
        OPENCODE_TEST_MANAGED_CONFIG_DIR: paths.managedConfig,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
        OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
        OPENCODE_DISABLE_SHARE: '1',
        [provider.keyEnv]: testingKey,
        npm_config_cache: paths.npmCache,
        GARCON_TEST_OPENCODE_REAL_BINARY: OPENCODE_BINARY,
        GARCON_TEST_OPENCODE_VERIFICATION: paths.verification,
        GARCON_TEST_OPENCODE_PROCESS_STATE: paths.processState,
        PATH: `${paths.bin}:${SYSTEM_PATH}`,
      };
    },
    async prepareWorkspace(directories) {
      const paths = openCodePaths(directories);
      await Promise.all([
        paths.bin,
        paths.processState,
        paths.xdgConfig,
        paths.globalConfig,
        paths.xdgData,
        paths.xdgState,
        paths.xdgCache,
        paths.npmCache,
        paths.managedConfig,
        paths.temp,
      ].map((directory) => mkdir(directory, { recursive: true })));
      await writeFile(paths.config, JSON.stringify(liveOpenCodeConfig(provider), null, 2), {
        mode: 0o600,
      });
      await writeOpenCodePluginSeed(paths.globalConfig);
      await writeOpenCodeSupervisorShim(paths.bin);
      const version = await verifyPinnedBinaryVersion({
        binary: OPENCODE_BINARY,
        expectedVersion: OPENCODE_VERSION,
        env: {
          HOME: directories.home,
          PATH: SYSTEM_PATH,
        },
      });
      await writeJsonAtomic(paths.verification, {
        binary: OPENCODE_BINARY,
        version,
      } satisfies OpenCodeBinaryVerification);
    },
    async afterGarconStop(directories) {
      await terminateOrphanedOpenCodeSupervisors(directories);
    },
  };
}

export function liveOpenCodeStartRequest(input: {
  chatId: string;
  projectPath: string;
  command: string;
}): StartChatCommandRequest {
  return {
    origin: 'interactive',
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    agentId: 'opencode',
    projectPath: input.projectPath,
    model: liveOpenCodeProvider().model,
    permissionMode: 'bypassPermissions',
    thinkingMode: LIVE_OPENCODE_THINKING_MODE,
    agentSettings: OPENCODE_AGENT_SETTINGS,
    command: input.command,
  };
}

export function liveOpenCodeRunRequest(input: {
  chatId: string;
  command: string;
}): Omit<AgentRunCommandRequest, 'transcriptViewId'> {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    command: input.command,
    permissionMode: 'bypassPermissions',
    thinkingMode: LIVE_OPENCODE_THINKING_MODE,
    agentSettings: OPENCODE_AGENT_SETTINGS,
    model: liveOpenCodeProvider().model,
  };
}
