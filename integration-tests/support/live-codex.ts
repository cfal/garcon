import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type {
  AgentRunCommandRequest,
  ForkRunCommandRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.js';
import type { IntegrationDirectories } from './integration-fixture.js';

export const LIVE_CODEX_MODEL = 'gpt-5.4-nano';
export const LIVE_CODEX_THINKING_MODE = 'low';

const CODEX_BINARY = fileURLToPath(
  new URL('../node_modules/.bin/codex', import.meta.url),
);
const CODEX_AGENT_SETTINGS: AgentSettingsEnvelope = {
  ownerId: 'codex',
  schemaVersion: 1,
  values: {},
};
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
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

export async function liveCodexServerEnvironment(): Promise<Record<string, string>> {
  const testingKey = process.env.OPENAI_TESTING_KEY?.trim();
  if (!testingKey) {
    throw new Error('OPENAI_TESTING_KEY is required for live Codex integration tests.');
  }
  await access(CODEX_BINARY, constants.X_OK);
  const nodeBinary = Bun.which('node');
  if (!nodeBinary) {
    throw new Error('Node.js is required to launch the pinned Codex package.');
  }

  // The temporary custom provider keeps the user's Codex home and login untouched.
  return {
    GARCON_CODEX_CLI: CODEX_BINARY,
    OPENAI_API_KEY: testingKey,
    PATH: `${dirname(nodeBinary)}:${SYSTEM_PATH}`,
  };
}

export async function prepareLiveCodexHome(
  directories: IntegrationDirectories,
): Promise<void> {
  const codexHome = join(directories.home, '.codex');
  const catalogPath = join(codexHome, 'live-models.json');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(catalogPath, JSON.stringify(LIVE_MODEL_CATALOG), { mode: 0o600 });
  await writeFile(join(codexHome, 'config.toml'), [
    'model_provider = "garcon-live-openai"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    '',
    '[model_providers.garcon-live-openai]',
    'name = "Garcon Live OpenAI"',
    'base_url = "https://api.openai.com/v1"',
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
  ].join('\n'), { mode: 0o600 });
}

export function liveCodexStartRequest(input: {
  chatId: string;
  projectPath: string;
  command: string;
  permissionMode?: StartChatCommandRequest['permissionMode'];
}): StartChatCommandRequest {
  return {
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
}): AgentRunCommandRequest {
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
}): ForkRunCommandRequest {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    sourceChatId: input.sourceChatId,
    chatId: input.chatId,
    command: input.command,
    permissionMode: 'default',
    thinkingMode: LIVE_CODEX_THINKING_MODE,
    agentSettings: CODEX_AGENT_SETTINGS,
    model: LIVE_CODEX_MODEL,
  };
}
