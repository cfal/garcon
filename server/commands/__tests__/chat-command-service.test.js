import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { ChatCommandService } from '../chat-command-service.ts';
import { CommandLedger } from '../command-ledger.ts';

let workspaceDir;

function makeService() {
  const chats = {
    getChat: mock((chatId) => (chatId === '1' ? { id: '1', agentId: 'claude' } : null)),
    addChat: mock(() => true),
    removeChat: mock(() => true),
  };
  const queue = {
    submit: mock(() => Promise.resolve(undefined)),
    registerPendingUserInput: mock(() => Promise.resolve(undefined)),
    runAcceptedTurn: mock(() => Promise.resolve(undefined)),
  };
  const settings = {
    getUiSettings: mock(() => Promise.resolve(null)),
    getChatName: mock(() => null),
    setSessionName: mock(() => Promise.resolve(undefined)),
    setLastChatDefaults: mock(() => Promise.resolve(undefined)),
    ensureInNormal: mock(() => Promise.resolve(undefined)),
    removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
  };
  const metadata = {
    addNewChatMetadata: mock(() => undefined),
  };
  const agents = {
    hasAgent: mock(() => true),
    supportsImages: mock(() => true),
    modelSupportsImages: mock(() => Promise.resolve(true)),
    startSession: mock(() => Promise.resolve(undefined)),
    resolvePermission: mock(() => undefined),
    getAgentAuthStatusMap: mock(() => ({})),
    getAgentReadinessMap: mock(() => ({})),
    getAgentCatalogEntries: mock(() => []),
    runSingleQuery: mock(() => Promise.resolve('')),
  };
  const pendingInputs = {
    register: mock(() => Promise.resolve(undefined)),
    clearChat: mock(() => undefined),
  };
  const service = new ChatCommandService({
    chats,
    queue,
    ledger: new CommandLedger(workspaceDir),
    settings,
    metadata,
    agents,
    pendingInputs,
  });
  return { service, chats, queue };
}

describe('ChatCommandService', () => {
  beforeEach(async () => {
    workspaceDir = path.join(os.tmpdir(), `garcon-command-service-${randomUUID()}`);
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('rejects empty commands consistently for HTTP and WebSocket submissions', async () => {
    const { service } = makeService();

    await expect(service.submitRun({
      transport: 'http',
      chatId: '1',
      command: '',
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(service.submitRun({
      transport: 'websocket',
      chatId: '1',
      command: '',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('deduplicates HTTP retries without resubmitting queue work', async () => {
    const { service, queue } = makeService();
    const input = {
      transport: 'http',
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

  it('submits WebSocket runs through the queue with generated turn ids', async () => {
    const { service, queue } = makeService();

    const result = await service.submitRun({
      transport: 'websocket',
      chatId: '1',
      command: 'hello',
      options: { model: 'opus' },
    });

    expect(result.commandType).toBe('agent-run');
    expect(result.clientRequestId).toBeTruthy();
    expect(result.turnId).toBeTruthy();
    expect(queue.submit).toHaveBeenCalledWith('1', 'hello', expect.objectContaining({
      model: 'opus',
      clientRequestId: result.clientRequestId,
      turnId: result.turnId,
    }));
  });
});
