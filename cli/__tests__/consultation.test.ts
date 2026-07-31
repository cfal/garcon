import { describe, expect, test } from 'bun:test';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type {
  AgentRunCommandRequest,
  AgentTurnCommandResponse,
  StartChatCommandRequest,
} from '@garcon/common/chat-command-contracts';
import type { ChatListResponse } from '@garcon/common/chat-list';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import type { CliInvocation } from '../args.js';
import { runConsultation, type ConsultationClient } from '../consultation.js';
import { CliError } from '../errors.js';
import type { CliOutput } from '../output.js';

const CHAT_ID = '1785337200123456';
const accepted: AgentTurnCommandResponse = {
  success: true,
  commandType: 'chat-start',
  clientRequestId: 'request',
  chatId: CHAT_ID,
  turnId: 'turn-1',
  status: 'accepted',
  acceptedAt: new Date().toISOString(),
};
const receipt: AgentTurnReceipt = {
  state: 'completed',
  chatId: CHAT_ID,
  turnId: 'turn-1',
  acceptedAt: accepted.acceptedAt,
  settledAt: new Date().toISOString(),
  output: { availability: 'available', completeness: 'complete', assistantMessages: ['Done'] },
};

function catalog(): ModelCatalogResponse {
  return {
    catalog: {
      agents: [{
        id: 'codex', label: 'Codex', kind: 'agent', supportsFork: true,
        supportsForkAtMessage: true, supportsForkWhileRunning: false,
        supportsUpdateProjectPath: true, supportsImages: true,
        acceptsApiProviderEndpoints: false, supportedProtocols: [], authLoginSupported: true,
        supportedPermissionModes: ['default', 'acceptEdits', 'plan'],
        supportedThinkingModes: ['none', 'high'], settings: [],
        defaultSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
        requiresStrictModelDiscovery: true, generation: null, defaultModel: 'gpt-5.4',
        models: [{ value: 'gpt-5.4', label: 'GPT 5.4' }],
      }],
      apiProviders: [],
    },
  };
}

const settings = {
  executionDefaults: {
    global: { permissionMode: 'acceptEdits', thinkingMode: 'high', agentSettingsById: {} },
    byAgent: {},
  },
} as RemoteSettingsSnapshot;

function output(): CliOutput & { acceptedIds: string[]; messages: string[][] } {
  return {
    acceptedIds: [], messages: [],
    accepted(chatId) { this.acceptedIds.push(chatId); },
    completed(messages) { this.messages.push([...messages]); },
    diagnostic() {},
  };
}

function client(overrides: Partial<ConsultationClient> = {}): ConsultationClient & {
  starts: StartChatCommandRequest[];
  runs: AgentRunCommandRequest[];
} {
  return {
    starts: [], runs: [],
    async getModelCatalog() { return catalog(); },
    async getSettings() { return settings; },
    async listChats() { throw new Error('chat list should not be loaded'); },
    async startChat(request) { this.starts.push(request); return accepted; },
    async runChat(request) { this.runs.push(request); return { ...accepted, commandType: 'agent-run' }; },
    async getTurnReceipt() { return receipt; },
    async verifyRuntime() { return true; },
    ...overrides,
  };
}

describe('runConsultation', () => {
  test('starts a tagged write-capable chat and prints its result', async () => {
    const invocation: CliInvocation = {
      kind: 'start', workspace: 'default', configDir: '/config', cwd: '/repo',
      agentId: 'codex', model: 'gpt-5.4', prompt: 'Implement it', readsPromptFromStdin: false,
    };
    const testClient = client();
    const testOutput = output();
    await runConsultation(invocation, 'Implement it', testClient, testOutput, undefined, {
      createId: () => 'request', createChatId: () => CHAT_ID,
    });
    expect(testClient.starts[0]).toMatchObject({
      chatId: CHAT_ID, agentId: 'codex', projectPath: '/repo', command: 'Implement it',
      permissionMode: 'acceptEdits', thinkingMode: 'high', tags: ['cli'],
    });
    expect(testOutput.acceptedIds).toEqual([CHAT_ID]);
    expect(testOutput.messages).toEqual([['Done']]);
  });

  test('minimal resume delegates persisted selection to atomic server admission', async () => {
    const invocation: CliInvocation = {
      kind: 'resume', workspace: 'default', configDir: '/config', chatId: CHAT_ID,
      prompt: 'Continue', readsPromptFromStdin: false,
    };
    const testClient = client();
    await runConsultation(invocation, 'Continue', testClient, output(), undefined, {
      createId: () => 'request',
    });
    expect(testClient.runs[0]).toEqual({
      clientRequestId: 'request', clientMessageId: 'request', chatId: CHAT_ID,
      command: 'Continue', tagsToAdd: ['cli'],
    });
  });

  test('validates resume overrides against the persisted agent catalog', async () => {
    const chats = {
      sessions: [{ id: CHAT_ID, agentId: 'codex' }], total: 1, lastSelectedChatId: null,
    } as ChatListResponse;
    const testClient = client({ async listChats() { return chats; } });
    const invocation: CliInvocation = {
      kind: 'resume', workspace: 'default', configDir: '/config', chatId: CHAT_ID,
      model: 'gpt-5.4', permissionMode: 'plan', thinkingMode: 'high',
      prompt: 'Review', readsPromptFromStdin: false,
    };
    await runConsultation(invocation, 'Review', testClient, output(), undefined, {
      createId: () => 'request',
    });
    expect(testClient.runs[0]).toMatchObject({
      model: 'gpt-5.4', apiProviderId: null, modelEndpointId: null,
      modelProtocol: null, permissionMode: 'plan', thinkingMode: 'high', tagsToAdd: ['cli'],
    });
  });

  test('never prints partial text from a failed turn', async () => {
    const failed = {
      ...receipt,
      state: 'failed',
      error: 'provider failed',
      output: { availability: 'available', completeness: 'best-effort', assistantMessages: ['Partial'] },
    } as AgentTurnReceipt;
    const testOutput = output();
    try {
      await runConsultation({
        kind: 'resume', workspace: 'default', configDir: '/config', chatId: CHAT_ID,
        prompt: 'Continue', readsPromptFromStdin: false,
      }, 'Continue', client({ async getTurnReceipt() { return failed; } }), testOutput, undefined, {
        createId: () => 'request',
      });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(1);
    }
    expect(testOutput.messages).toEqual([]);
  });
});
