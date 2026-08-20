import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type {
  AgentRunCommandRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.js';
import type { IntegrationFixtureOptions } from './integration-fixture.js';
import {
  OPENCODE_VERSION,
  openCodePaths,
  writeOpenCodePluginSeed,
} from './scripted-opencode.js';
import { verifyPinnedBinaryVersion } from './opencode-process-supervisor.js';

export const LIVE_OPENCODE_MODEL = 'deepseek/deepseek-v4-flash';
export const LIVE_OPENCODE_THINKING_MODE = 'none';

const OPENCODE_BINARY = fileURLToPath(
  new URL('../node_modules/.bin/opencode', import.meta.url),
);
const OPENCODE_AGENT_SETTINGS: AgentSettingsEnvelope = {
  ownerId: 'opencode',
  schemaVersion: 1,
  values: {},
};
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function requiredTestingKey(): string {
  const key = process.env.OPENCODE_TESTING_KEY?.trim();
  if (!key) {
    throw new Error('OPENCODE_TESTING_KEY is required for live OpenCode integration tests.');
  }
  return key;
}

function liveOpenCodeConfig(): Record<string, unknown> {
  return {
    formatter: false,
    lsp: false,
    enabled_providers: ['deepseek'],
    model: LIVE_OPENCODE_MODEL,
    small_model: LIVE_OPENCODE_MODEL,
    agent: {
      title: { disable: true },
      summary: { disable: true },
    },
  };
}

export async function liveOpenCodeFixtureOptions(): Promise<IntegrationFixtureOptions> {
  const testingKey = requiredTestingKey();
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
        DEEPSEEK_API_KEY: testingKey,
        npm_config_cache: paths.npmCache,
        PATH: `${dirname(OPENCODE_BINARY)}:${SYSTEM_PATH}`,
      };
    },
    async prepareWorkspace(directories) {
      const paths = openCodePaths(directories);
      await Promise.all([
        paths.xdgConfig,
        paths.globalConfig,
        paths.xdgData,
        paths.xdgState,
        paths.xdgCache,
        paths.npmCache,
        paths.managedConfig,
        paths.temp,
      ].map((directory) => mkdir(directory, { recursive: true })));
      await writeFile(paths.config, JSON.stringify(liveOpenCodeConfig(), null, 2), {
        mode: 0o600,
      });
      await writeOpenCodePluginSeed(paths.globalConfig);
      await verifyPinnedBinaryVersion({
        binary: OPENCODE_BINARY,
        expectedVersion: OPENCODE_VERSION,
        env: {
          HOME: directories.home,
          PATH: SYSTEM_PATH,
        },
      });
    },
  };
}

export function liveOpenCodeStartRequest(input: {
  chatId: string;
  projectPath: string;
  command: string;
}): StartChatCommandRequest {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    agentId: 'opencode',
    projectPath: input.projectPath,
    model: LIVE_OPENCODE_MODEL,
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
    model: LIVE_OPENCODE_MODEL,
  };
}
