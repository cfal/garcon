// Runs the real pinned Antigravity CLI (`agy`) with its model swapped for a
// script. agy authenticates with `gemini-api-key` and sends every agent turn to
// GOOGLE_GEMINI_BASE_URL, which points at FakeGeminiModel, so CLI behavior stays
// real while every model choice is deterministic and no Google account is used.
// The fixture's isolated HOME keeps the user's ~/.gemini untouched.
//
// ANTIGRAVITY_BIN names the pinned binary installed by
// `bun scripts/install-antigravity-cli.ts`; suites skip when it is unset.

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type {
  AgentRunCommandRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.js';
import type { PermissionMode } from '../../common/chat-modes.js';
import { FakeGeminiModel, FAKE_GEMINI_API_KEY } from './fake-gemini-model.js';
import type { IntegrationDirectories } from './integration-fixture.js';
import { waitForPersistedNativeSession } from './persisted-chat.js';

// agy 1.5.13's model list for a Gemini API key; the fake accepts any model name.
export const ANTIGRAVITY_TEST_MODEL = 'gemini-3.1-pro-low';
export const ANTIGRAVITY_TEST_ALTERNATE_MODEL = 'gemini-3.1-pro-high';

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const ANTIGRAVITY_AGENT_SETTINGS: AgentSettingsEnvelope = {
  ownerId: 'antigravity',
  schemaVersion: 1,
  values: {},
};

export const ANTIGRAVITY_BINARY = process.env.ANTIGRAVITY_BIN ?? '';

export interface ScriptedAntigravityTestEnvironment {
  readonly model: FakeGeminiModel;
  readonly serverEnvironment: Record<string, string>;
  prepareWorkspace(directories: IntegrationDirectories): Promise<void>;
  dispose(): void;
}

// agy logs this line whenever it starts its background self-updater, which
// would replace the binary that running sessions use.
const UPDATER_SPAWN_LOG = 'Spawned background update process';

// Each agy run writes its own log under `log/`.
export async function antigravityUpdaterSpawns(directories: IntegrationDirectories): Promise<number> {
  const logDir = join(directories.home, '.gemini', 'antigravity-cli', 'log');
  const names = await readdir(logDir);
  if (!names.length) throw new Error(`No agy logs found in ${logDir}`);
  let spawns = 0;
  for (const name of names) {
    const text = await Bun.file(join(logDir, name)).text();
    spawns += text.split('\n').filter((line) => line.includes(UPDATER_SPAWN_LOG)).length;
  }
  return spawns;
}

export function startScriptedAntigravityTestEnvironment(): ScriptedAntigravityTestEnvironment {
  if (!ANTIGRAVITY_BINARY) throw new Error('ANTIGRAVITY_BIN must point to the pinned Antigravity CLI.');
  const model = FakeGeminiModel.start();
  return {
    model,
    serverEnvironment: {
      GARCON_ANTIGRAVITY_BINARY: ANTIGRAVITY_BINARY,
      GEMINI_API_KEY: FAKE_GEMINI_API_KEY,
      GOOGLE_GEMINI_BASE_URL: model.baseUrl,
      PATH: SYSTEM_PATH,
    },
    async prepareWorkspace(directories) {
      // `agy models` lists Gemini API models only with this documented setting.
      const settingsDir = join(directories.home, '.gemini', 'antigravity-cli');
      await mkdir(settingsDir, { recursive: true });
      await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ modelProvider: 'gemini' }), { mode: 0o600 });
    },
    dispose: () => model.stop(),
  };
}

export function scriptedAntigravityStartRequest(input: {
  chatId: string;
  projectPath: string;
  command: string;
  model?: string;
  permissionMode?: PermissionMode;
}): StartChatCommandRequest {
  return {
    origin: 'interactive',
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    agentId: 'antigravity',
    projectPath: input.projectPath,
    model: input.model ?? ANTIGRAVITY_TEST_MODEL,
    permissionMode: input.permissionMode ?? 'default',
    thinkingMode: 'none',
    agentSettings: ANTIGRAVITY_AGENT_SETTINGS,
    command: input.command,
  };
}

export function scriptedAntigravityRunRequest(input: {
  chatId: string;
  command: string;
  model?: string;
  permissionMode?: PermissionMode;
}): Omit<AgentRunCommandRequest, 'transcriptViewId'> {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    command: input.command,
    permissionMode: input.permissionMode ?? 'default',
    thinkingMode: 'none',
    agentSettings: ANTIGRAVITY_AGENT_SETTINGS,
    model: input.model ?? ANTIGRAVITY_TEST_MODEL,
  };
}

export async function antigravityAgentSessionId(
  fixture: { readonly dirs: IntegrationDirectories },
  chatId: string,
): Promise<string> {
  const chat = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'antigravity' });
  if (typeof chat.agentSessionId !== 'string' || !chat.agentSessionId) {
    throw new Error(`Chat ${chatId} has no Antigravity session identity.`);
  }
  return chat.agentSessionId;
}
