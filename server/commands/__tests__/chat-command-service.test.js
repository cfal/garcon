import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { ChatCommandService } from '../chat-command-service.ts';
import { CommandLedger } from '../command-ledger.ts';
import { UserMessage } from '../../../common/chat-types.js';
import { attachNativeMessageSource } from '../../agents/shared/native-message-source.js';
import { ChatIdAllocator } from '../../chats/chat-id-allocator.js';
import {
  ACTIVE_INPUT_NOT_DELIVERED_MESSAGE,
  ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
  ActiveInputDeliveryError,
} from '../../lib/domain-error.js';

let workspaceDir;
let projectBaseDir;
let originalProjectBaseDir;
const SOURCE_CHAT_ID = '1783725900000000';
const TARGET_CHAT_ID = '1783725900000001';
const SCHEDULED_CHAT_ID = '1783725900000002';

function makeService(overrides = {}) {
  const session = {
    id: SOURCE_CHAT_ID,
    agentId: 'claude',
    agentSessionId: 'agent-1',
    nativePath: '/tmp/agent-1.jsonl',
    projectPath: '/repo',
    model: 'opus',
    tags: [],
    ...overrides.session,
  };
  const sessions = new Map([
    [SOURCE_CHAT_ID, session],
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
    abort: mock(() => Promise.resolve(true)),
    deleteChatQueueFile: mock(() => Promise.resolve(undefined)),
    triggerDrain: mock(() => Promise.resolve(undefined)),
    readChatQueue: mock(() => Promise.resolve({ entries: [], paused: false, version: 0 })),
    enqueueChat: mock(() => Promise.resolve({
      entry: { id: 'entry-1' },
      queue: {
        entries: [{ id: 'entry-1', content: 'queued', status: 'queued', createdAt: '2026-02-27T00:00:00.000Z' }],
        paused: false,
        version: 1,
      },
    })),
    dequeueChat: mock(() => Promise.resolve({ entries: [], paused: false, version: 1 })),
    clearChatQueue: mock(() => Promise.resolve({ entries: [], paused: false, version: 1 })),
    pauseChatQueue: mock(() => Promise.resolve({ entries: [], paused: true, version: 1 })),
    resumeChatQueue: mock(() => Promise.resolve({ entries: [], paused: false, version: 1 })),
    ...overrides.queue,
  };
  const settings = {
    getUiSettings: mock(() => null),
    getChatName: mock(() => null),
    setSessionName: mock(() => Promise.resolve(undefined)),
    recordChatStartup: mock(() => Promise.resolve(undefined)),
    ensureInNormal: mock(() => Promise.resolve(undefined)),
    removeFromAllOrderLists: mock(() => Promise.resolve(undefined)),
    removeSessionName: mock(() => Promise.resolve(undefined)),
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
    supportsForkAtMessage: mock(() => true),
    supportsForkWhileRunning: mock(() => false),
    supportsUpdateProjectPath: mock(() => true),
    requiresNativePathForProjectPathUpdate: mock((agentId) => agentId === 'pi'),
    isAgentSessionRunning: mock(() => false),
    forkAgentSession: mock(() => Promise.resolve(null)),
    compactSession: mock(() => Promise.resolve(undefined)),
    resolveNativePath: mock((chat) => Promise.resolve(chat.nativePath ?? null)),
    prepareProjectPathUpdate: mock(() => Promise.resolve(undefined)),
    getAgentAuthStatusMap: mock(() => ({})),
    getAgentReadinessMap: mock(() => ({})),
    getAgentCatalogEntries: mock(() => []),
    runSingleQuery: mock(() => Promise.resolve('')),
    ...overrides.agents,
  };
  const pendingInputs = {
    register: mock(() => Promise.resolve(undefined)),
    clearChat: mock(() => undefined),
    reconcile: mock(() => Promise.resolve(undefined)),
    listForChat: mock(() => []),
    ...overrides.pendingInputs,
  };
  const forkChatFileCopy = mock(() => Promise.resolve({
    sourceChatId: SOURCE_CHAT_ID,
    chatId: TARGET_CHAT_ID,
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
    chatIds: overrides.chatIds ?? new ChatIdAllocator(chats),
    nativeMessages: overrides.nativeMessages,
    forkChatFileCopy,
  });
  return { service, chats, queue, settings, agents, pendingInputs, forkChatFileCopy, ledger, sessions };
}

async function readLedgerRecords() {
  const raw = await fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8');
  return JSON.parse(raw).records;
}

function attachment(mimeType, content = 'hello') {
  return {
    data: `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`,
    name: 'attachment.bin',
    mimeType,
  };
}

describe('ChatCommandService', () => {
  beforeEach(async () => {
    workspaceDir = path.join(os.tmpdir(), `garcon-command-service-${randomUUID()}`);
    projectBaseDir = path.join(os.tmpdir(), `garcon-command-service-project-${randomUUID()}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(projectBaseDir, { recursive: true });
    originalProjectBaseDir = process.env.GARCON_PROJECT_BASE_DIR;
    process.env.GARCON_PROJECT_BASE_DIR = projectBaseDir;
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(projectBaseDir, { recursive: true, force: true });
    if (originalProjectBaseDir === undefined) {
      delete process.env.GARCON_PROJECT_BASE_DIR;
    } else {
      process.env.GARCON_PROJECT_BASE_DIR = originalProjectBaseDir;
    }
  });

  it('rejects empty commands', async () => {
    const { service } = makeService();

    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: '',
      clientRequestId: 'req-1',
      clientMessageId: 'msg-1',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects unsupported direct run attachments before scheduling queue work', async () => {
    const { service, queue } = makeService();

    await expect(service.submitRun({
      chatId: SOURCE_CHAT_ID,
      command: 'inspect this file',
      images: [attachment('application/octet-stream')],
      clientRequestId: 'req-bad-attachment',
      clientMessageId: 'msg-bad-attachment',
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      message: 'Invalid file type. Only images, Markdown, text, and PDF files are allowed.',
    });

    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
    expect(queue.runAcceptedTurn).not.toHaveBeenCalled();
  });

  it('rejects unsupported chat start attachments before creating the chat', async () => {
    const { service, chats, agents } = makeService();

    await expect(service.submitStart({
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start with this file',
      model: 'opus',
      images: [attachment('application/octet-stream')],
      clientRequestId: 'req-start-bad-attachment',
      clientMessageId: 'msg-start-bad-attachment',
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });

    expect(chats.addChat).not.toHaveBeenCalled();
    expect(agents.startSession).not.toHaveBeenCalled();
  });

  it('normalizes chat start tags before storing the command and chat', async () => {
    const { service, chats } = makeService();

    const result = await service.submitStart({
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'start with normalized tags',
      model: 'opus',
      tags: ['Review Needed', 'review-needed', '  QA  ', 42, '!!!'],
      clientRequestId: 'req-start-tags',
      clientMessageId: 'msg-start-tags',
    });

    expect(result.status).toBe('accepted');
    expect(chats.addChat).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['qa', 'review-needed'],
    }));

    const records = await readLedgerRecords();
    expect(records[0].payload.tags).toEqual(['qa', 'review-needed']);
  });

  it('keeps interactive and scheduled new-chat creation behavior conformant', async () => {
    const allocate = mock(() => SCHEDULED_CHAT_ID);
    const { service, chats, agents } = makeService({ chatIds: { allocate } });
    const shared = {
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'review the repository',
      model: 'opus',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'default',
      thinkingMode: 'ultra',
      claudeThinkingMode: 'auto',
      ampAgentMode: 'smart',
    };

    await service.submitStart({
      ...shared,
      chatId: TARGET_CHAT_ID,
      clientRequestId: 'req-interactive',
      clientMessageId: 'msg-interactive',
    });
    const scheduled = await service.submitScheduledStart({
      ...shared,
      clientRequestId: 'req-scheduled',
      clientMessageId: 'msg-scheduled',
    });

    expect(scheduled.chatId).toBe(SCHEDULED_CHAT_ID);
    expect(allocate).toHaveBeenCalledTimes(1);
    const [{ id: interactiveId, ...interactive }, { id: scheduledId, ...scheduledEntry }] =
      chats.addChat.mock.calls.map(([entry]) => entry);
    expect(interactiveId).toBe(TARGET_CHAT_ID);
    expect(scheduledId).toBe(SCHEDULED_CHAT_ID);
    expect(scheduledEntry).toEqual(interactive);
    expect(interactive.thinkingMode).toBe('none');
    expect(interactive.tags).toEqual([]);
    expect(agents.startSession).toHaveBeenNthCalledWith(
      1,
      TARGET_CHAT_ID,
      shared.command,
      expect.objectContaining({ projectPath: projectBaseDir }),
    );
    expect(agents.startSession).toHaveBeenNthCalledWith(
      2,
      SCHEDULED_CHAT_ID,
      shared.command,
      expect.objectContaining({ projectPath: projectBaseDir }),
    );
  });

  it('requires command identity and rejects invalid IDs before ledger acceptance', async () => {
    const { service, chats } = makeService();
    const input = {
      chatId: TARGET_CHAT_ID,
      agentId: 'claude',
      projectPath: projectBaseDir,
      command: 'hello',
      model: 'opus',
      clientRequestId: '',
      clientMessageId: 'msg-start',
    };

    await expect(service.submitStart(input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'clientRequestId is required',
    });
    await expect(service.submitStart({
      ...input,
      chatId: '178372590000007231252',
      clientRequestId: 'req-start',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(chats.addChat).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(workspaceDir, 'command-ledger.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects chat starts outside the configured project base', async () => {
    const { service, agents, chats } = makeService({ session: null });
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-command-service-outside-'));

    try {
      await expect(service.submitStart({
        chatId: TARGET_CHAT_ID,
        agentId: 'claude',
        projectPath: outsidePath,
        command: 'hello',
        model: 'opus',
        clientRequestId: 'req-start-outside',
        clientMessageId: 'msg-start-outside',
      })).rejects.toMatchObject({
        code: 'PROJECT_PATH_OUTSIDE_BASE',
        status: 403,
      });

      expect(chats.addChat).not.toHaveBeenCalled();
      expect(agents.startSession).not.toHaveBeenCalled();
    } finally {
      await fs.rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('deduplicates HTTP retries without resubmitting queue work', async () => {
    const { service, queue } = makeService();
    const input = {
      chatId: SOURCE_CHAT_ID,
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
      chatId: SOURCE_CHAT_ID,
      command: 'continue',
      clientRequestId: 'req-fail-1',
      clientMessageId: 'msg-fail-1',
    })).rejects.toThrow('append failed');

    const records = await readLedgerRecords();
    expect(records[0]).toMatchObject({
      commandType: 'agent-run',
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-fail-1',
      status: 'failed',
      error: 'append failed',
      errorCode: 'PRE_SCHEDULE_FAILED',
    });
    expect(queue.discardPendingUserInput).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'req-fail-1');
    expect(queue.runAcceptedTurn).not.toHaveBeenCalled();
  });

  it('does not return duplicate accepted after a failed pre-schedule append', async () => {
    const { service, queue } = makeService();
    const input = {
      chatId: SOURCE_CHAT_ID,
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
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
    })).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      status: 409,
    });

    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('deletes chats through the mutation service cleanup path', async () => {
    const { service, chats, queue, settings, pendingInputs, sessions } = makeService();

    const result = await service.deleteChat({ chatId: SOURCE_CHAT_ID });

    expect(result).toEqual({ success: true, chatId: SOURCE_CHAT_ID });
    expect(queue.abort).toHaveBeenCalledWith(SOURCE_CHAT_ID, { drainAfterAbort: false });
    expect(pendingInputs.clearChat).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'chat-removed');
    expect(chats.removeChat).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(queue.deleteChatQueueFile).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(settings.removeFromAllOrderLists).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(settings.removeSessionName).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(sessions.has(SOURCE_CHAT_ID)).toBe(false);
  });

  it('rejects deleting unknown chats', async () => {
    const { service, queue } = makeService();

    await expect(service.deleteChat({ chatId: 'missing' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
    expect(queue.abort).not.toHaveBeenCalled();
  });

  it('rejects malformed message-point fork sequence values', async () => {
    const { service, forkChatFileCopy } = makeService();

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: '2abc',
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });

    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('rejects message-point forks when the agent does not support them', async () => {
    const nativeMessages = {
      loadNativeMessages: mock(() => Promise.resolve([])),
    };
    const { service, agents, forkChatFileCopy } = makeService({ nativeMessages });
    agents.supportsForkAtMessage.mockReturnValue(false);

    await expect(service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 1,
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_AGENT',
      status: 422,
    });

    expect(nativeMessages.loadNativeMessages).not.toHaveBeenCalled();
    expect(forkChatFileCopy).not.toHaveBeenCalled();
  });

  it('forks a running source when the agent supports fork-while-running', async () => {
    const { service, agents, forkChatFileCopy } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkWhileRunning.mockReturnValue(true);

    await service.forkChat({ sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID });

    expect(forkChatFileCopy).toHaveBeenCalledTimes(1);
  });

  it('resolves message-point forks to the native source line', async () => {
    const first = attachNativeMessageSource(
      new UserMessage('2026-03-27T08:00:00.000Z', 'first'),
      { entryId: 'entry-1', lineNumber: 2 },
    );
    const second = attachNativeMessageSource(
      new UserMessage('2026-03-27T08:01:00.000Z', 'second'),
      { entryId: 'entry-2', lineNumber: 5 },
    );
    const nativeMessages = {
      loadNativeMessages: mock(() => Promise.resolve([first, second])),
    };
    const { service, forkChatFileCopy } = makeService({ nativeMessages });

    await service.forkChat({ sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID, upToSeq: 2 });

    expect(nativeMessages.loadNativeMessages).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(forkChatFileCopy).toHaveBeenCalledWith(expect.objectContaining({
      sourceChatId: SOURCE_CHAT_ID,
      targetChatId: TARGET_CHAT_ID,
      truncateAfterEntryId: 'entry-2',
      truncateAfterLine: 5,
    }));
  });

  it('allows message-point forks while the source is processing when the agent supports running forks', async () => {
    const first = attachNativeMessageSource(
      new UserMessage('2026-03-27T08:00:00.000Z', 'first'),
      { entryId: 'entry-1', lineNumber: 2 },
    );
    const nativeMessages = {
      loadNativeMessages: mock(() => Promise.resolve([first])),
    };
    const { service, agents, forkChatFileCopy } = makeService({ nativeMessages });
    agents.isAgentSessionRunning.mockReturnValue(true);
    agents.supportsForkWhileRunning.mockReturnValue(true);

    await service.forkChat({
      sourceChatId: SOURCE_CHAT_ID,
      chatId: TARGET_CHAT_ID,
      upToSeq: 1,
    });

    expect(nativeMessages.loadNativeMessages).toHaveBeenCalledWith(SOURCE_CHAT_ID);
    expect(forkChatFileCopy).toHaveBeenCalledWith(expect.objectContaining({
      sourceChatId: SOURCE_CHAT_ID,
      targetChatId: TARGET_CHAT_ID,
      truncateAfterEntryId: 'entry-1',
      truncateAfterLine: 2,
    }));
  });

  it('forwards structured permission decision responses to agents', async () => {
    const { service, agents } = makeService();
    const response = { outcome: { outcome: 'accepted' } };

    await service.submitPermissionDecision({
      chatId: SOURCE_CHAT_ID,
      permissionRequestId: 'perm-1',
      allow: true,
      alwaysAllow: false,
      response,
      clientRequestId: 'req-perm-1',
    });

    expect(agents.resolvePermission).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'perm-1', {
      allow: true,
      alwaysAllow: false,
      response,
    });

    const records = await readLedgerRecords();
    expect(records[0].payload.response).toEqual(response);
  });

  it('routes /compact to the agent compaction dispatch', async () => {
    const { service, agents, chats } = makeService();
    chats.addChat({ id: SOURCE_CHAT_ID, agentId: 'claude', agentSessionId: 'agent-1' });

    const result = await service.submitCompact({
      chatId: SOURCE_CHAT_ID,
      clientRequestId: 'req-compact-1',
      instructions: 'focus on api',
    });

    expect(result.status).toBe('accepted');
    // Compaction is dispatched in the background, so let the microtask run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agents.compactSession).toHaveBeenCalledWith(SOURCE_CHAT_ID, expect.objectContaining({
      instructions: 'focus on api',
      clientRequestId: 'req-compact-1',
    }));
  });

  it('refuses /compact while a turn is already running', async () => {
    const { service, agents, chats } = makeService();
    chats.addChat({ id: SOURCE_CHAT_ID, agentId: 'claude', agentSessionId: 'agent-1' });
    agents.isAgentSessionRunning = mock(() => true);

    await expect(service.submitCompact({ chatId: SOURCE_CHAT_ID, clientRequestId: 'req-compact-2' }))
      .rejects.toThrow(/Cannot compact while a turn is running/);
    expect(agents.compactSession).not.toHaveBeenCalled();
  });

  it('strips internal sending entries from the enqueue response queue', async () => {
    // Enqueuing while a previous entry is mid-dispatch ('sending') must not leak
    // that entry to the client: it already lives in the transcript.
    const postEnqueue = {
      entries: [
        { id: 's1', content: 'in flight', status: 'sending', createdAt: '2026-02-27T00:00:00.000Z' },
        { id: 'q1', content: 'still waiting', status: 'queued', createdAt: '2026-02-27T00:00:01.000Z' },
      ],
      paused: false,
      version: 7,
    };
    const { service } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve({ entries: [], paused: false })),
        enqueueChat: mock(() => Promise.resolve({ entry: { id: 'q1' }, queue: postEnqueue })),
        triggerDrain: mock(() => Promise.resolve(undefined)),
      },
    });

    const result = await service.submitQueueEnqueue({
      chatId: SOURCE_CHAT_ID,
      content: 'still waiting',
      clientRequestId: 'req-enqueue-1',
    });

    expect(result.queue.entries.map((e) => e.id)).toEqual(['q1']);
    expect(result.queue.entries.every((e) => e.status === 'queued')).toBe(true);
  });

  it('deduplicates queue retries across the optional delivery contract upgrade', async () => {
    const { service, queue } = makeService();
    const legacy = {
      chatId: SOURCE_CHAT_ID,
      content: 'queued across deploy',
      clientRequestId: 'request-cross-version',
    };

    const first = await service.submitQueueEnqueue(legacy);
    const retry = await service.submitQueueEnqueue({ ...legacy, delivery: 'queue' });

    expect(first.status).toBe('accepted');
    expect(retry.status).toBe('duplicate');
    expect(queue.enqueueChat).toHaveBeenCalledTimes(1);
  });

  it('completes handled active input without exposing a synthetic queue entry', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve({ entries: [], paused: false, version: 4 })),
        enqueueChat: mock(() => Promise.resolve({
          handledActive: true,
          entry: {
            id: 'request-active',
            content: '/goal pause',
            status: 'sending',
            createdAt: '2026-07-10T00:00:00.000Z',
          },
          queue: { entries: [], paused: false, version: 4 },
        })),
      },
    });

    const result = await service.submitQueueEnqueue({
      chatId: SOURCE_CHAT_ID,
      content: '/goal pause',
      clientRequestId: 'request-active',
      delivery: 'active',
    });

    expect(result.status).toBe('accepted');
    expect(result.queue.entries).toEqual([]);
    expect(result.entryId).toBe('request-active');
    expect(queue.triggerDrain).not.toHaveBeenCalled();
    expect(queue.enqueueChat).toHaveBeenCalledWith(SOURCE_CHAT_ID, '/goal pause', {
      clientRequestId: 'request-active',
      activeInputPolicy: 'allow-active-input',
    });
    const records = await readLedgerRecords();
    expect(records.at(-1)?.status).toBe('finished');
  });

  it('reopens pre-accept active delivery failures for the same request id', async () => {
    let attempts = 0;
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve({ entries: [], paused: false, version: 0 })),
        enqueueChat: mock(async () => {
          attempts += 1;
          if (attempts === 1) throw new ActiveInputDeliveryError(new Error('live registration failed'), false);
          return {
            entry: { id: 'queued-retry' },
            queue: {
              entries: [{ id: 'queued-retry', content: 'retry me', status: 'queued', createdAt: '2026-07-10T00:00:00.000Z' }],
              paused: false,
              version: 1,
            },
          };
        }),
      },
    });

    const input = { chatId: SOURCE_CHAT_ID, content: 'retry me', clientRequestId: 'request-retry' };
    await expect(service.submitQueueEnqueue(input)).rejects.toMatchObject({
      message: ACTIVE_INPUT_NOT_DELIVERED_MESSAGE,
      cause: expect.objectContaining({ message: 'live registration failed' }),
      deliveryAccepted: false,
      retryable: true,
    });
    let records = await readLedgerRecords();
    expect(records.at(-1)).toEqual(expect.objectContaining({
      status: 'failed',
      errorCode: 'PRE_SCHEDULE_FAILED',
    }));

    await expect(service.submitQueueEnqueue(input)).resolves.toEqual(expect.objectContaining({ status: 'accepted' }));
    records = await readLedgerRecords();
    expect(records.at(-1)?.status).toBe('scheduled');
    expect(queue.enqueueChat).toHaveBeenCalledTimes(2);
  });

  it('sends scheduled input immediately when the existing chat is idle', async () => {
    const { service, queue } = makeService();

    const outcome = await service.submitScheduledExistingChat({
      chatId: SOURCE_CHAT_ID,
      command: 'scheduled prompt',
      busyBehavior: 'queue',
      clientRequestId: 'scheduled-prompt-1',
      clientMessageId: 'scheduled-message-1',
    });

    expect(outcome).toEqual({ type: 'sent', chatId: SOURCE_CHAT_ID });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.registerPendingUserInput).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      'scheduled prompt',
      expect.objectContaining({
        clientRequestId: 'scheduled-prompt-1',
        clientMessageId: 'scheduled-message-1',
      }),
    );
    expect(queue.enqueueChat).not.toHaveBeenCalled();
  });

  it('strictly queues scheduled input when the existing chat is busy', async () => {
    const { service, agents, queue } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);

    const outcome = await service.submitScheduledExistingChat({
      chatId: SOURCE_CHAT_ID,
      command: 'scheduled prompt',
      busyBehavior: 'queue',
      clientRequestId: 'scheduled-prompt-2',
      clientMessageId: 'scheduled-message-2',
    });

    expect(outcome).toEqual({ type: 'queued', chatId: SOURCE_CHAT_ID, entryId: 'entry-1' });
    expect(queue.enqueueChat).toHaveBeenCalledWith(SOURCE_CHAT_ID, 'scheduled prompt', {
      clientRequestId: 'scheduled-prompt-2',
      activeInputPolicy: 'queue-only',
    });
    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
  });

  it('skips scheduled input without queue side effects when configured', async () => {
    const { service, agents, queue } = makeService();
    agents.isAgentSessionRunning.mockReturnValue(true);

    const outcome = await service.submitScheduledExistingChat({
      chatId: SOURCE_CHAT_ID,
      command: 'scheduled prompt',
      busyBehavior: 'skip',
      clientRequestId: 'scheduled-prompt-3',
      clientMessageId: 'scheduled-message-3',
    });

    expect(outcome).toEqual({ type: 'skipped-busy', chatId: SOURCE_CHAT_ID });
    expect(queue.enqueueChat).not.toHaveBeenCalled();
    expect(queue.registerPendingUserInput).not.toHaveBeenCalled();
  });

  it('does not replay post-accept active delivery failures for the same request id', async () => {
    const { service, queue } = makeService({
      queue: {
        readChatQueue: mock(() => Promise.resolve({ entries: [], paused: false, version: 0 })),
        enqueueChat: mock(async () => {
          throw new ActiveInputDeliveryError(new Error('live steer failed after acceptance'), true);
        }),
      },
    });
    const input = {
      chatId: SOURCE_CHAT_ID,
      content: 'deliver once',
      clientRequestId: 'request-accepted',
    };

    await expect(service.submitQueueEnqueue(input)).rejects.toMatchObject({
      message: ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
      cause: expect.objectContaining({ message: 'live steer failed after acceptance' }),
      deliveryAccepted: true,
      retryable: false,
    });
    let records = await readLedgerRecords();
    expect(records.at(-1)).toEqual(expect.objectContaining({
      status: 'failed',
      error: ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
    }));
    expect(records.at(-1)?.errorCode).toBeUndefined();

    await expect(service.submitQueueEnqueue(input)).resolves.toEqual(expect.objectContaining({
      status: 'duplicate',
      clientRequestId: 'request-accepted',
    }));
    records = await readLedgerRecords();
    expect(records.at(-1)?.status).toBe('failed');
    expect(queue.enqueueChat).toHaveBeenCalledTimes(1);
  });

  it('strips internal sending entries from mutate (dequeue) responses', async () => {
    const afterDequeue = {
      entries: [
        { id: 's1', content: 'in flight', status: 'sending', createdAt: '2026-02-27T00:00:00.000Z' },
      ],
      paused: false,
      version: 9,
    };
    const { service } = makeService({
      queue: {
        dequeueChat: mock(() => Promise.resolve(afterDequeue)),
      },
    });

    const result = await service.mutateQueue({ chatId: SOURCE_CHAT_ID, action: 'dequeue', entryId: 'q1' });

    expect(result.queue.entries).toEqual([]);
  });

  it('updates the project path only after the chat is idle and the agent is prepared', async () => {
    const { service, chats, agents, sessions } = makeService();
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    const realNextPath = await fs.realpath(nextPath);

    const result = await service.updateProjectPath({
      chatId: SOURCE_CHAT_ID,
      projectPath: nextPath,
    });

    expect(result).toEqual({
      success: true,
      chatId: SOURCE_CHAT_ID,
      projectPath: realNextPath,
      previousProjectPath: '/repo',
      nativePath: '/tmp/agent-1.jsonl',
    });
    expect(agents.prepareProjectPathUpdate).toHaveBeenCalledWith('claude', expect.objectContaining({
      chatId: SOURCE_CHAT_ID,
      agentSessionId: 'agent-1',
      previousProjectPath: '/repo',
      nextProjectPath: realNextPath,
      nativePath: '/tmp/agent-1.jsonl',
    }));
    expect(chats.updateChat).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      { projectPath: realNextPath },
      { flush: true },
    );
    expect(sessions.get(SOURCE_CHAT_ID).projectPath).toBe(realNextPath);
  });

  it('rejects project path updates while a turn is running', async () => {
    const { service, agents } = makeService();
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    agents.isAgentSessionRunning.mockReturnValueOnce(true);

    await expect(service.updateProjectPath({ chatId: SOURCE_CHAT_ID, projectPath: nextPath }))
      .rejects.toMatchObject({ code: 'CHAT_NOT_IDLE', status: 409 });

    expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });

  it('rejects project path updates while a queued turn is dispatching', async () => {
    const { service, queue, agents } = makeService();
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });
    queue.readChatQueue.mockResolvedValueOnce({
      entries: [
        { id: 'sending-1', content: 'continue', status: 'sending', createdAt: '2026-02-27T00:00:00.000Z' },
      ],
      paused: false,
      version: 2,
    });

    await expect(service.updateProjectPath({ chatId: SOURCE_CHAT_ID, projectPath: nextPath }))
      .rejects.toMatchObject({ code: 'CHAT_NOT_IDLE', status: 409 });

    expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });

  it('rejects project path updates with pending submitted input after reconcile', async () => {
    const { service, agents } = makeService({
      pendingInputs: {
        listForChat: mock(() => [{ chatId: SOURCE_CHAT_ID, clientRequestId: 'req-1' }]),
      },
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(service.updateProjectPath({ chatId: SOURCE_CHAT_ID, projectPath: nextPath }))
      .rejects.toMatchObject({ code: 'CHAT_NOT_IDLE', status: 409 });

    expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });

  it('resolves an artificial native path before changing directories', async () => {
    const resolvedNativePath = '/tmp/resolved-agent-1.jsonl';
    const { service, chats, agents } = makeService({
      session: { nativePath: '!claude:agent-1' },
      agents: {
        resolveNativePath: mock(() => Promise.resolve(resolvedNativePath)),
      },
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });

    await service.updateProjectPath({ chatId: SOURCE_CHAT_ID, projectPath: nextPath });

    expect(agents.resolveNativePath).toHaveBeenCalledWith(expect.objectContaining({
      id: SOURCE_CHAT_ID,
      projectPath: '/repo',
      nativePath: '!claude:agent-1',
    }));
    expect(agents.prepareProjectPathUpdate).toHaveBeenCalledWith('claude', expect.objectContaining({
      nativePath: resolvedNativePath,
    }));
    expect(chats.updateChat).toHaveBeenCalledWith(
      SOURCE_CHAT_ID,
      expect.objectContaining({ nativePath: resolvedNativePath }),
      { flush: true },
    );
  });

  it('rejects Pi project path updates when the native transcript path cannot be resolved', async () => {
    const { service, chats, agents } = makeService({
      session: {
        agentId: 'pi',
        nativePath: '!pi:agent-1',
      },
      agents: {
        resolveNativePath: mock(() => Promise.resolve(null)),
      },
    });
    const nextPath = path.join(projectBaseDir, 'repo-worktree');
    await fs.mkdir(nextPath, { recursive: true });

    await expect(service.updateProjectPath({ chatId: SOURCE_CHAT_ID, projectPath: nextPath }))
      .rejects.toMatchObject({ code: 'PROJECT_PATH_NATIVE_PATH_UNRESOLVED', status: 409 });

    expect(agents.prepareProjectPathUpdate).not.toHaveBeenCalled();
    expect(chats.updateChat).not.toHaveBeenCalled();
  });
});
