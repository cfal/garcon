import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { ChatCommandService } from '../chat-command-service.ts';
import { CommandLedger } from '../command-ledger.ts';

let workspaceDir;

function makeService() {
  const sessions = new Map([
    ['1', {
      id: '1',
      agentId: 'claude',
      agentSessionId: 'agent-1',
      nativePath: '/tmp/agent-1.jsonl',
      projectPath: '/repo',
      model: 'opus',
      tags: [],
    }],
  ]);
  const chats = {
    getChat: mock((chatId) => sessions.get(chatId) ?? null),
    addChat: mock((entry) => {
      if (sessions.has(entry.id)) return false;
      sessions.set(entry.id, entry);
      return true;
    }),
    updateChat: mock((chatId, patch) => {
      const current = sessions.get(chatId);
      if (!current) return null;
      sessions.set(chatId, { ...current, ...patch });
      return sessions.get(chatId);
    }),
    removeChat: mock((chatId) => sessions.delete(chatId)),
  };
  const queue = {
    registerPendingUserInput: mock(() => Promise.resolve(undefined)),
    discardPendingUserInput: mock(() => true),
    runAcceptedTurn: mock(() => Promise.resolve(undefined)),
  };
  const settings = {
    getUiSettings: mock(() => null),
    getChatName: mock(() => null),
    setSessionName: mock(() => Promise.resolve(undefined)),
    recordChatStartup: mock(() => Promise.resolve(undefined)),
    ensureInNormal: mock(() => Promise.resolve(undefined)),
    removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
  };
  const metadata = {
    addNewChatMetadata: mock(() => undefined),
    getChatMetadata: mock(() => null),
  };
  const agents = {
    hasAgent: mock(() => true),
    supportsImages: mock(() => true),
    modelSupportsImages: mock(() => Promise.resolve(true)),
    startSession: mock(() => Promise.resolve(undefined)),
    resolvePermission: mock(() => undefined),
    supportsFork: mock(() => true),
    supportsForkWhileRunning: mock(() => false),
    isAgentSessionRunning: mock(() => false),
    forkAgentSession: mock(() => Promise.resolve(null)),
    compactSession: mock(() => Promise.resolve(undefined)),
    getAgentAuthStatusMap: mock(() => ({})),
    getAgentReadinessMap: mock(() => ({})),
    getAgentCatalogEntries: mock(() => []),
    runSingleQuery: mock(() => Promise.resolve('')),
  };
  const pendingInputs = {
    register: mock(() => Promise.resolve(undefined)),
    clearChat: mock(() => undefined),
  };
  const forkChatFileCopy = mock(() => Promise.resolve({
    sourceChatId: '1',
    chatId: '2',
    agentId: 'claude',
    agentSessionId: 'agent-2',
    nativePath: '/tmp/agent-2.jsonl',
  }));
  const ledger = new CommandLedger(workspaceDir);
  const service = new ChatCommandService({
    chats,
    queue,
    ledger,
    settings,
    metadata,
    agents,
    pendingInputs,
    forkChatFileCopy,
  });
  return { service, chats, queue, agents, forkChatFileCopy, ledger };
}

async function readLedgerRecords() {
  const raw = await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8');
  return JSON.parse(raw).records;
}

describe('ChatCommandService', () => {
  beforeEach(async () => {
    workspaceDir = path.join(os.tmpdir(), `garcon-command-service-${randomUUID()}`);
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('rejects empty commands', async () => {
    const { service } = makeService();

    await expect(service.submitRun({
      chatId: '1',
      command: '',
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('deduplicates HTTP retries without resubmitting queue work', async () => {
    const { service, queue } = makeService();
    const input = {
      chatId: '1',
      command: 'continue',
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
      options: { model: 'opus' },
    };

    const first = await service.submitRun(input);
    const second = await service.submitRun(input);

    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(1);
    expect(queue.runAcceptedTurn).toHaveBeenCalledTimes(1);
  });

  it('marks accepted HTTP commands failed when durable submit append fails', async () => {
    const { service, queue } = makeService();
    queue.registerPendingUserInput.mockRejectedValueOnce(new Error('append failed'));

    await expect(service.submitRun({
      chatId: '1',
      command: 'continue',
      clientRequestId: 'req-fail-1',
      clientMessageId: 'msg-fail-1',
    })).rejects.toThrow('append failed');

    const records = await readLedgerRecords();
    expect(records[0]).toMatchObject({
      commandType: 'agent-run',
      chatId: '1',
      clientRequestId: 'req-fail-1',
      status: 'failed',
      error: 'append failed',
      errorCode: 'PRE_SCHEDULE_FAILED',
    });
    expect(queue.discardPendingUserInput).toHaveBeenCalledWith('1', 'req-fail-1');
    expect(queue.runAcceptedTurn).not.toHaveBeenCalled();
  });

  it('does not return duplicate accepted after a failed pre-schedule append', async () => {
    const { service, queue } = makeService();
    const input = {
      chatId: '1',
      command: 'continue',
      clientRequestId: 'req-retry-1',
      clientMessageId: 'msg-retry-1',
    };
    queue.registerPendingUserInput
      .mockRejectedValueOnce(new Error('append failed'))
      .mockResolvedValueOnce(undefined);

    await expect(service.submitRun(input)).rejects.toThrow('append failed');
    const retry = await service.submitRun(input);

    expect(retry.status).toBe('accepted');
    expect(queue.registerPendingUserInput).toHaveBeenCalledTimes(2);
    expect(queue.runAcceptedTurn).toHaveBeenCalledTimes(1);
  });

  it('applies shared fork validation before copying', async () => {
    const { service, agents, forkChatFileCopy } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);

    await expect(service.forkChat({
      sourceChatId: '1',
      chatId: '2',
    })).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      status: 409,
    });

    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('forks a running source when the agent supports fork-while-running', async () => {
    const { service, agents, forkChatFileCopy } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkWhileRunning.mockReturnValue(true);

    await service.forkChat({ sourceChatId: '1', chatId: '2' });

    expect(forkChatFileCopy).toHaveBeenCalledTimes(1);
  });

  it('forwards structured permission decision responses to agents', async () => {
    const { service, agents } = makeService();
    const response = { outcome: { outcome: 'accepted' } };

    await service.submitPermissionDecision({
      chatId: '1',
      permissionRequestId: 'perm-1',
      allow: true,
      alwaysAllow: false,
      response,
      clientRequestId: 'req-perm-1',
    });

    expect(agents.resolvePermission).toHaveBeenCalledWith('1', 'perm-1', {
      allow: true,
      alwaysAllow: false,
      response,
    });

    const records = await readLedgerRecords();
    expect(records[0].payload.response).toEqual(response);
  });

  it('routes /compact to the agent compaction dispatch', async () => {
    const { service, agents, chats } = makeService();
    chats.addChat({ id: '1', agentId: 'claude', agentSessionId: 'agent-1' });

    const result = await service.submitCompact({
      chatId: '1',
      clientRequestId: 'req-compact-1',
      instructions: 'focus on api',
    });

    expect(result.status).toBe('accepted');
    // Compaction is dispatched in the background, so let the microtask run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agents.compactSession).toHaveBeenCalledWith('1', expect.objectContaining({
      instructions: 'focus on api',
      clientRequestId: 'req-compact-1',
    }));
  });

  it('refuses /compact while a turn is already running', async () => {
    const { service, agents, chats } = makeService();
    chats.addChat({ id: '1', agentId: 'claude', agentSessionId: 'agent-1' });
    agents.isAgentSessionRunning = mock(() => true);

    await expect(service.submitCompact({ chatId: '1', clientRequestId: 'req-compact-2' }))
      .rejects.toThrow(/Cannot compact while a turn is running/);
    expect(agents.compactSession).not.toHaveBeenCalled();
  });
});
