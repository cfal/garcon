import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type {
  AgentRunCommandRequest,
  ForkRunCommandRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.js';
import {
  assertSensitiveValuesNotPersisted,
  type IntegrationDirectories,
} from './integration-fixture.js';
import { withTimeout } from './deferred.js';

export const LIVE_CODEX_MODEL = 'gpt-5.4-nano';
export const LIVE_CODEX_THINKING_MODE = 'low';
export type CodexTestToolMode = 'direct' | 'code_mode' | 'code_mode_only';

const CODEX_BINARY = fileURLToPath(
  new URL('../node_modules/.bin/codex', import.meta.url),
);
const CODEX_AGENT_SETTINGS: AgentSettingsEnvelope = {
  ownerId: 'codex',
  schemaVersion: 1,
  values: {},
};
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const PROXY_START_TIMEOUT_MS = 10_000;
const PROXY_STOP_TIMEOUT_MS = 5_000;
const LIVE_MODEL_CATALOG = {
  models: [{
    slug: LIVE_CODEX_MODEL,
    prefer_websockets: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    input_modalities: ['text'],
    supports_image_detail_original: false,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    tool_mode: null,
    multi_agent_version: null,
    use_responses_lite: false,
    include_skills_usage_instructions: false,
    auto_review_model_override: null,
    context_window: 272_000,
    max_context_window: 272_000,
    auto_compact_token_limit: null,
    comp_hash: null,
    reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none',
    display_name: 'GPT-5.4 Nano',
    description: 'Low-cost model used by Garcon live integration tests.',
    default_reasoning_level: LIVE_CODEX_THINKING_MODE,
    supported_reasoning_levels: [{
      effort: LIVE_CODEX_THINKING_MODE,
      description: 'Lowest supported reasoning effort',
    }],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority: 1,
    model_messages: null,
    experimental_supported_tools: [],
    supports_search_tool: false,
    default_service_tier: null,
    service_tiers: [],
    additional_speed_tiers: [],
    supports_reasoning_summaries: true,
    base_instructions: 'You are Codex, a coding agent. Follow the user request exactly.',
  }],
};

export interface LiveCodexTestEnvironment {
  readonly forbiddenPersistedValues: readonly string[];
  readonly proxyBaseUrl: string;
  readonly serverEnvironment: Record<string, string>;
  prepareWorkspace(directories: IntegrationDirectories): Promise<void>;
  dispose(): Promise<void>;
}

interface LiveCodexTestEnvironmentOptions {
  upstreamUrl?: string;
  // Scripted-model environments proxy to a local fake, so any placeholder key works and no
  // credential needs to exist in the environment.
  testingKey?: string;
  toolMode?: CodexTestToolMode;
}

type CodexProxyProcess = Bun.Subprocess<'pipe', 'ignore', 'ignore'>;

function proxyEnvironment(root: string): Record<string, string> {
  return {
    HOME: root,
    PATH: process.env.PATH ?? SYSTEM_PATH,
    NO_COLOR: '1',
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
  };
}

async function waitForProxyBaseUrl(
  child: CodexProxyProcess,
  serverInfoPath: string,
): Promise<string> {
  const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(serverInfoPath, 'utf8')) as { port?: unknown };
      if (
        typeof parsed.port === 'number'
        && Number.isInteger(parsed.port)
        && parsed.port > 0
        && parsed.port <= 65_535
      ) {
        return `http://127.0.0.1:${parsed.port}`;
      }
      throw new Error('Live Codex credential proxy wrote invalid startup metadata.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (child.exitCode !== null) {
      throw new Error('Live Codex credential proxy exited before startup.');
    }
    await Bun.sleep(25);
  }
  throw new Error('Timed out waiting for the live Codex credential proxy.');
}

async function stopProxy(child: CodexProxyProcess, proxyBaseUrl: string): Promise<void> {
  if (child.exitCode === null) {
    await fetch(`${proxyBaseUrl}/shutdown`).catch(() => undefined);
  }
  try {
    await withTimeout(
      child.exited,
      PROXY_STOP_TIMEOUT_MS,
      () => 'Timed out stopping the live Codex credential proxy.',
    );
  } catch (error) {
    child.kill('SIGTERM');
    await child.exited;
    throw error;
  }
}

async function removeProxyRoot(root: string, testingKey: string): Promise<void> {
  let scanError: unknown;
  try {
    await assertSensitiveValuesNotPersisted({
      directory: root,
      diagnostics: null,
      values: [testingKey],
    });
  } catch (error) {
    scanError = error;
  }
  await rm(root, { recursive: true, force: true });
  if (scanError) throw scanError;
}

export async function startLiveCodexTestEnvironment(
  options: LiveCodexTestEnvironmentOptions = {},
): Promise<LiveCodexTestEnvironment> {
  const testingKey = options.testingKey ?? process.env.OPENAI_TESTING_KEY?.trim();
  if (!testingKey) {
    throw new Error('OPENAI_TESTING_KEY is required for live Codex integration tests.');
  }
  await access(CODEX_BINARY, constants.X_OK);
  const nodeBinary = Bun.which('node');
  if (!nodeBinary) {
    throw new Error('Node.js is required to launch the pinned Codex package.');
  }

  const root = await mkdtemp(join(tmpdir(), 'garcon-live-codex-proxy-'));
  const serverInfoPath = join(root, 'server-info.json');
  const command = [
    CODEX_BINARY,
    'responses-api-proxy',
    '--http-shutdown',
    '--server-info',
    serverInfoPath,
    ...(options.upstreamUrl ? ['--upstream-url', options.upstreamUrl] : []),
  ];
  let child: CodexProxyProcess | undefined;
  let proxyBaseUrl: string;
  try {
    child = Bun.spawn({
      cmd: command,
      env: proxyEnvironment(root),
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    child.stdin.write(`${testingKey}\n`);
    child.stdin.end();
    proxyBaseUrl = await waitForProxyBaseUrl(child, serverInfoPath);
  } catch (error) {
    if (child) {
      child.kill('SIGTERM');
      await child.exited.catch(() => undefined);
    }
    try {
      await removeProxyRoot(root, testingKey);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Live Codex credential proxy startup and cleanup failed.',
      );
    }
    throw error;
  }

  const serverEnvironment = {
    GARCON_CODEX_CLI: CODEX_BINARY,
    PATH: `${dirname(nodeBinary)}:${SYSTEM_PATH}`,
  };

  return {
    forbiddenPersistedValues: [testingKey],
    proxyBaseUrl,
    serverEnvironment,
    async prepareWorkspace(directories) {
      const codexHome = join(directories.home, '.codex');
      const catalogPath = join(codexHome, 'live-models.json');
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      const modelCatalog = {
        ...LIVE_MODEL_CATALOG,
        models: LIVE_MODEL_CATALOG.models.map((model) => ({
          ...model,
          tool_mode: options.toolMode ?? model.tool_mode,
        })),
      };
      await writeFile(catalogPath, JSON.stringify(modelCatalog), { mode: 0o600 });
      await writeFile(join(codexHome, 'config.toml'), [
        'model_provider = "garcon-live-openai"',
        `model_catalog_json = ${JSON.stringify(catalogPath)}`,
        '',
        '[model_providers.garcon-live-openai]',
        'name = "Garcon Live OpenAI"',
        `base_url = ${JSON.stringify(`${proxyBaseUrl}/v1`)}`,
        'wire_api = "responses"',
        '',
      ].join('\n'), { mode: 0o600 });
    },
    async dispose() {
      const errors: unknown[] = [];
      try {
        await stopProxy(child, proxyBaseUrl);
      } catch (error) {
        errors.push(error);
      }
      try {
        await removeProxyRoot(root, testingKey);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Live Codex credential proxy cleanup failed.');
      }
    },
  };
}

export function liveCodexStartRequest(input: {
  chatId: string;
  projectPath: string;
  command: string;
  permissionMode?: StartChatCommandRequest['permissionMode'];
}): StartChatCommandRequest {
  return {
    origin: 'interactive',
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    agentId: 'codex',
    projectPath: input.projectPath,
    model: LIVE_CODEX_MODEL,
    permissionMode: input.permissionMode ?? 'default',
    thinkingMode: LIVE_CODEX_THINKING_MODE,
    agentSettings: CODEX_AGENT_SETTINGS,
    command: input.command,
  };
}

export function liveCodexRunRequest(input: {
  chatId: string;
  command: string;
  permissionMode?: AgentRunCommandRequest['permissionMode'];
}): Omit<AgentRunCommandRequest, 'transcriptViewId'> {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    command: input.command,
    permissionMode: input.permissionMode ?? 'default',
    thinkingMode: LIVE_CODEX_THINKING_MODE,
    agentSettings: CODEX_AGENT_SETTINGS,
    model: LIVE_CODEX_MODEL,
  };
}

export function liveCodexForkRunRequest(input: {
  sourceChatId: string;
  chatId: string;
  command: string;
  permissionMode?: ForkRunCommandRequest['permissionMode'];
}): ForkRunCommandRequest {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    sourceChatId: input.sourceChatId,
    chatId: input.chatId,
    command: input.command,
    permissionMode: input.permissionMode ?? 'default',
    thinkingMode: LIVE_CODEX_THINKING_MODE,
    agentSettings: CODEX_AGENT_SETTINGS,
    model: LIVE_CODEX_MODEL,
  };
}
