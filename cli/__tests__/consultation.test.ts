import { describe, expect, test } from 'bun:test';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type {
  AgentRunCommandRequest,
  AgentTurnCommandResponse,
  StartChatCommandRequest,
} from '@garcon/common/chat-command-contracts';
import type { ChatListResponse } from '@garcon/common/chat-list';
import type { UpdateChatTitleRequest } from '@garcon/common/chat-title-contracts';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import type { CliInvocation } from '../args.js';
import { runConsultation, type ConsultationClient } from '../consultation.js';
import { CliError } from '../errors.js';
import { GarconHttpError } from '../garcon-client.js';
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
  clientRequestId: accepted.clientRequestId,
  acceptedAt: accepted.acceptedAt,
  updatedAt: accepted.acceptedAt,
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

function output(): CliOutput & {
  acceptedHandles: Array<{ chatId: string; turnId: string }>;
  messages: string[][];
} {
  return {
    acceptedHandles: [], messages: [],
    accepted({ chatId, turnId }) { this.acceptedHandles.push({ chatId, turnId }); },
    completed(messages) { this.messages.push([...messages]); },
    result() {},
    sent() {},
    stopped() {},
    diagnostic() {},
  };
}

function client(overrides: Partial<ConsultationClient> = {}): ConsultationClient & {
  starts: StartChatCommandRequest[];
  runs: AgentRunCommandRequest[];
  titles: UpdateChatTitleRequest[];
} {
  return {
    starts: [], runs: [], titles: [],
    async getModelCatalog() { return catalog(); },
    async getSettings() { return settings; },
    async listChats() { throw new Error('chat list should not be loaded'); },
    async startChat(request) { this.starts.push(request); return accepted; },
    async runChat(request) { this.runs.push(request); return { ...accepted, commandType: 'agent-run' }; },
    async updateChatTitle(request) { this.titles.push(request); },
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
      title: 'Implementation review',
      additionalTags: ['review-needed'],
    };
    const testClient = client();
    const testOutput = output();
    await runConsultation(invocation, 'Implement it', testClient, testOutput, undefined, {
      createId: () => 'request', createChatId: () => CHAT_ID,
    });
    expect(testClient.starts[0]).toMatchObject({
      chatId: CHAT_ID, agentId: 'codex', projectPath: '/repo', command: 'Implement it',
      permissionMode: 'acceptEdits', thinkingMode: 'high', tags: ['cli', 'review-needed'],
    });
    expect(testOutput.acceptedHandles).toEqual([{ chatId: CHAT_ID, turnId: 'turn-1' }]);
    expect(testClient.titles).toEqual([{ chatId: CHAT_ID, title: 'Implementation review' }]);
    expect(testOutput.messages).toEqual([['Done']]);
  });

  test('retries a server-reported chat ID collision with entirely new identities', async () => {
    const chatIds = [CHAT_ID, '1785337200123457'];
    const requestIds = ['request-1', 'message-1', 'request-2', 'message-2'];
    const starts: StartChatCommandRequest[] = [];
    const testClient = client({
      async startChat(request) {
        starts.push(request);
        if (starts.length === 1) {
          throw new GarconHttpError(
            'submission',
            'chat ID collision',
            409,
            'CHAT_ID_COLLISION',
            false,
          );
        }
        return {
          ...accepted,
          clientRequestId: request.clientRequestId,
          chatId: request.chatId,
        };
      },
      async getTurnReceipt(chatId, _turnId) {
        return {
          ...receipt,
          chatId,
          clientRequestId: 'request-2',
        };
      },
    });
    const invocation: CliInvocation = {
      kind: 'start', workspace: 'default', configDir: '/config', cwd: '/repo',
      agentId: 'codex', model: 'gpt-5.4', prompt: 'Implement it', readsPromptFromStdin: false,
    };

    await runConsultation(invocation, 'Implement it', testClient, output(), undefined, {
      createId: () => requestIds.shift()!,
      createChatId: () => chatIds.shift()!,
    });

    expect(starts).toHaveLength(2);
    expect(starts.map(({ chatId, clientRequestId, clientMessageId }) => ({
      chatId,
      clientRequestId,
      clientMessageId,
    }))).toEqual([
      { chatId: CHAT_ID, clientRequestId: 'request-1', clientMessageId: 'message-1' },
      { chatId: '1785337200123457', clientRequestId: 'request-2', clientMessageId: 'message-2' },
    ]);
  });

  test('minimal resume delegates persisted selection to atomic server admission', async () => {
    const invocation: CliInvocation = {
      kind: 'resume', workspace: 'default', configDir: '/config', chatId: CHAT_ID,
      prompt: 'Continue', readsPromptFromStdin: false,
      title: 'Follow-up review',
      additionalTags: ['follow-up'],
    };
    const testClient = client();
    await runConsultation(invocation, 'Continue', testClient, output(), undefined, {
      createId: () => 'request',
    });
    expect(testClient.runs[0]).toEqual({
      clientRequestId: 'request', clientMessageId: 'request', chatId: CHAT_ID,
      command: 'Continue', tagsToAdd: ['follow-up'],
      permissionFallbackPolicy: 'require-explicit-bypass',
    });
    expect(testClient.titles).toEqual([{ chatId: CHAT_ID, title: 'Follow-up review' }]);
  });

  test('returns the agent result before surfacing a title update failure', async () => {
    const testOutput = output();
    let receiptRead = false;
    const testClient = client({
      async updateChatTitle() {
        throw new CliError('title update', 'rename failed', 3);
      },
      async getTurnReceipt() {
        receiptRead = true;
        return receipt;
      },
    });

    await expect(runConsultation({
      kind: 'resume', workspace: 'default', configDir: '/config', chatId: CHAT_ID,
      prompt: 'Continue', readsPromptFromStdin: false, title: 'Follow-up review',
    }, 'Continue', testClient, testOutput, undefined, {
      createId: () => 'request',
    })).rejects.toThrow('rename failed');

    expect(receiptRead).toBe(true);
    expect(testOutput.acceptedHandles).toEqual([{ chatId: CHAT_ID, turnId: 'turn-1' }]);
    expect(testOutput.messages).toEqual([['Done']]);
  });

  test('validates resume overrides against the persisted agent catalog', async () => {
    const chats = {
      sessions: [{ id: CHAT_ID, agentId: 'codex', agentOwnershipEpoch: 'epoch-1' }],
      total: 1,
      lastSelectedChatId: null,
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
      modelProtocol: null, permissionMode: 'plan', thinkingMode: 'high',
    });
    expect(testClient.runs[0]).not.toHaveProperty('tagsToAdd');
  });

  test('uses expectedAgentId when the explicit resume agent still owns the chat', async () => {
    const chats = {
      sessions: [{ id: CHAT_ID, agentId: 'codex', agentOwnershipEpoch: 'epoch-1' }],
      total: 1,
      lastSelectedChatId: null,
    } as ChatListResponse;
    const testClient = client({ async listChats() { return chats; } });

    await runConsultation({
      kind: 'resume', workspace: 'default', configDir: '/config', chatId: CHAT_ID,
      agentId: 'codex', prompt: 'Continue', readsPromptFromStdin: false,
    }, 'Continue', testClient, output(), undefined, { createId: () => 'request' });

    expect(testClient.runs[0]).toMatchObject({ expectedAgentId: 'codex' });
    expect(testClient.runs[0]).not.toHaveProperty('handoff');
  });

  test('submits an explicit cross-agent resume as one fenced handoff', async () => {
    const chats = {
      sessions: [{ id: CHAT_ID, agentId: 'claude', agentOwnershipEpoch: 'epoch-7' }],
      total: 1,
      lastSelectedChatId: null,
    } as ChatListResponse;
    const testClient = client({ async listChats() { return chats; } });

    await runConsultation({
      kind: 'resume', workspace: 'default', configDir: '/config', chatId: CHAT_ID,
      agentId: 'codex', prompt: 'Continue with Codex', readsPromptFromStdin: false,
    }, 'Continue with Codex', testClient, output(), undefined, { createId: () => 'request' });

    expect(testClient.runs[0]).toMatchObject({
      clientRequestId: 'request',
      chatId: CHAT_ID,
      command: 'Continue with Codex',
      permissionFallbackPolicy: 'require-explicit-bypass',
      handoff: {
        expectedAgentOwnershipEpoch: 'epoch-7',
        target: {
          agentId: 'codex',
          model: 'gpt-5.4',
          apiProviderId: null,
          modelEndpointId: null,
          modelProtocol: null,
          thinkingMode: 'high',
          agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
        },
      },
    });
    expect(testClient.runs[0].handoff?.target).not.toHaveProperty('permissionMode');
    expect(testClient.runs[0]).not.toHaveProperty('expectedAgentId');
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

  test('reports aggregate retention pressure without blaming turn size', async () => {
    const unavailable = {
      ...receipt,
      output: { availability: 'unavailable', reason: 'retention-pressure' },
    } as AgentTurnReceipt;

    await expect(runConsultation({
      kind: 'resume', workspace: 'default', configDir: '/config', chatId: CHAT_ID,
      prompt: 'Continue', readsPromptFromStdin: false,
    }, 'Continue', client({ async getTurnReceipt() { return unavailable; } }), output(), undefined, {
      createId: () => 'request',
    })).rejects.toThrow('server retention pressure');
  });

  test('reports native recovery without printing a false empty success', async () => {
    const unavailable = {
      ...receipt,
      output: { availability: 'unavailable', reason: 'recovery' },
    } as AgentTurnReceipt;

    await expect(runConsultation({
      kind: 'resume', workspace: 'default', configDir: '/config', chatId: CHAT_ID,
      prompt: 'Continue', readsPromptFromStdin: false,
    }, 'Continue', client({ async getTurnReceipt() { return unavailable; } }), output(), undefined, {
      createId: () => 'request',
    })).rejects.toThrow('server recovery rebuilt the transcript');
  });
});
