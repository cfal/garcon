import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type {
  AgentRunCommandRequest,
  ForkRunCommandRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.js';

export const LIVE_CLAUDE_MODEL = 'haiku';
export const LIVE_CLAUDE_THINKING_MODE = 'low';

const CLAUDE_BINARY = fileURLToPath(
  new URL('../node_modules/.bin/claude', import.meta.url),
);
const CLAUDE_AGENT_SETTINGS: AgentSettingsEnvelope = {
  ownerId: 'claude',
  schemaVersion: 1,
  values: {},
};

export async function liveClaudeServerEnvironment(): Promise<Record<string, string>> {
  const testingKey = process.env.ANTHROPIC_TESTING_KEY?.trim();
  if (!testingKey) {
    throw new Error('ANTHROPIC_TESTING_KEY is required for live Claude integration tests.');
  }
  await access(CLAUDE_BINARY, constants.X_OK);

  // The fixture isolates HOME and passes the testing key only to its Garcon child.
  return {
    ANTHROPIC_API_KEY: testingKey,
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: '',
    CLAUDE_BINARY,
  };
}

export function liveClaudeStartRequest(input: {
  chatId: string;
  projectPath: string;
  command: string;
  permissionMode?: StartChatCommandRequest['permissionMode'];
}): StartChatCommandRequest {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    agentId: 'claude',
    projectPath: input.projectPath,
    model: LIVE_CLAUDE_MODEL,
    permissionMode: input.permissionMode ?? 'default',
    thinkingMode: LIVE_CLAUDE_THINKING_MODE,
    agentSettings: CLAUDE_AGENT_SETTINGS,
    command: input.command,
  };
}

export function liveClaudeRunRequest(input: {
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
    thinkingMode: LIVE_CLAUDE_THINKING_MODE,
    agentSettings: CLAUDE_AGENT_SETTINGS,
    model: LIVE_CLAUDE_MODEL,
  };
}

export function liveClaudeForkRunRequest(input: {
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
    thinkingMode: LIVE_CLAUDE_THINKING_MODE,
    agentSettings: CLAUDE_AGENT_SETTINGS,
    model: LIVE_CLAUDE_MODEL,
  };
}
