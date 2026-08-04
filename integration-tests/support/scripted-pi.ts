// Runs the real pinned Pi CLI with its model swapped for a script. The CLI speaks the OpenAI
// Chat Completions API to the provider in models.json, which points at
// FakeChatCompletionsModel, so CLI behavior stays real while every model choice is
// deterministic and no credential is required. The fixture's HOME isolation keeps the user's
// ~/.pi untouched: both the spawned CLI and the in-server SDK discovery resolve ~/.pi/agent
// inside the temp home.

import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type {
  AgentRunCommandRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.js';
import { FakeChatCompletionsModel } from './fake-chat-completions-model.js';
import type { IntegrationDirectories } from './integration-fixture.js';

export const PI_TEST_PROVIDER = 'garcon-fake';
export const PI_TEST_MODEL_ID = 'fake-model';
export const PI_TEST_MODEL = `${PI_TEST_PROVIDER}/${PI_TEST_MODEL_ID}`;
export const PI_TEST_CLAMPED_THINKING_MODEL_ID = 'fake-model-without-off';
export const PI_TEST_CLAMPED_THINKING_MODEL =
  `${PI_TEST_PROVIDER}/${PI_TEST_CLAMPED_THINKING_MODEL_ID}`;
export const PI_TEST_THINKING_MODE = 'none';

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const PI_AGENT_SETTINGS: AgentSettingsEnvelope = {
  ownerId: 'pi',
  schemaVersion: 1,
  values: {},
};

export interface ScriptedPiTestEnvironment {
  readonly model: FakeChatCompletionsModel;
  readonly serverEnvironment: Record<string, string>;
  prepareWorkspace(directories: IntegrationDirectories): Promise<void>;
  dispose(): void;
}

export function startScriptedPiTestEnvironment(): ScriptedPiTestEnvironment {
  const model = FakeChatCompletionsModel.start();
  // The Pi bin uses /usr/bin/env node, so only the runner's node executable is exposed below.
  // Adding its whole directory would also expose ambient agent binaries to catalog discovery.
  const nodeBinary = Bun.which('node');
  if (!nodeBinary) {
    model.stop();
    throw new Error('node is required to run the pinned Pi CLI in integration tests');
  }
  const serverEnvironment: Record<string, string> = {
    GARCON_PI_BINARY: fileURLToPath(new URL('../node_modules/.bin/pi', import.meta.url)),
    PATH: SYSTEM_PATH,
  };
  return {
    model,
    serverEnvironment,
    async prepareWorkspace(directories) {
      const binDir = join(directories.home, '.garcon-test-bin');
      const agentDir = join(directories.home, '.pi', 'agent');
      await Promise.all([
        mkdir(binDir, { recursive: true }),
        mkdir(agentDir, { recursive: true }),
      ]);
      await symlink(nodeBinary, join(binDir, 'node'));
      serverEnvironment.PATH = `${binDir}:${SYSTEM_PATH}`;
      await writeFile(join(agentDir, 'models.json'), JSON.stringify({
        providers: {
          [PI_TEST_PROVIDER]: {
            baseUrl: `${model.baseUrl}/v1`,
            api: 'openai-completions',
            apiKey: 'garcon-test-key',
            models: [{
              id: PI_TEST_MODEL_ID,
              name: 'Garcon Fake Model',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }, {
              id: PI_TEST_CLAMPED_THINKING_MODEL_ID,
              name: 'Garcon Fake Model Without Off',
              reasoning: true,
              thinkingLevelMap: { off: null, minimal: 'low' },
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }],
          },
        },
      }), { mode: 0o600 });
    },
    dispose: () => model.stop(),
  };
}

export function scriptedPiStartRequest(input: {
  chatId: string;
  projectPath: string;
  command: string;
  model?: string;
  thinkingMode?: StartChatCommandRequest['thinkingMode'];
}): StartChatCommandRequest {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    agentId: 'pi',
    projectPath: input.projectPath,
    model: input.model ?? PI_TEST_MODEL,
    permissionMode: 'default',
    thinkingMode: input.thinkingMode ?? PI_TEST_THINKING_MODE,
    agentSettings: PI_AGENT_SETTINGS,
    command: input.command,
  };
}

export function scriptedPiRunRequest(input: {
  chatId: string;
  command: string;
  model?: string;
  thinkingMode?: AgentRunCommandRequest['thinkingMode'];
}): AgentRunCommandRequest {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    command: input.command,
    permissionMode: 'default',
    thinkingMode: input.thinkingMode ?? PI_TEST_THINKING_MODE,
    agentSettings: PI_AGENT_SETTINGS,
    model: input.model ?? PI_TEST_MODEL,
  };
}

export interface PiNativeSession {
  agentSessionId: string;
  path: string;
}

// Reads the workspace chat registry the way the fixture's direct-agent helpers do.
export async function piNativeSession(
  fixture: { readonly dirs: IntegrationDirectories },
  chatId: string,
): Promise<PiNativeSession> {
  const registry = JSON.parse(
    await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
  ) as { sessions?: Record<string, Record<string, unknown>> };
  const chat = registry.sessions?.[chatId];
  if (!chat) throw new Error(`Chat ${chatId} was not persisted.`);
  if (chat.agentId !== 'pi') throw new Error(`Chat ${chatId} is not a Pi chat.`);
  const agentSessionId = typeof chat.agentSessionId === 'string' ? chat.agentSessionId : '';
  const nativeSession = chat.nativeSession && typeof chat.nativeSession === 'object'
    ? chat.nativeSession as Record<string, unknown>
    : null;
  const value = nativeSession?.value && typeof nativeSession.value === 'object'
    ? nativeSession.value as Record<string, unknown>
    : null;
  const path = typeof value?.path === 'string' ? value.path : '';
  if (!agentSessionId || !path) {
    throw new Error(`Chat ${chatId} has no pi native session identity.`);
  }
  return { agentSessionId, path };
}
