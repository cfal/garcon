import { describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createClaudeAgent } from '../index.ts';
import { AgentEventEmitterRuntime } from '../../shared/event-emitter-runtime.ts';

function createClaudeStub(startError) {
  const claude = new AgentEventEmitterRuntime();
  claude.startClaudeCliSession = mock(() => Promise.reject(startError));
  claude.runClaudeTurn = mock(() => Promise.resolve(undefined));
  claude.abortClaudeInternalSession = mock(() => Promise.resolve(false));
  claude.isClaudeInternalSessionRunning = mock(() => false);
  claude.getRunningClaudeInternalSessions = mock(() => []);
  claude.resolveInternalToolApproval = mock(() => undefined);
  claude.startPurgeTimer = mock(() => setInterval(() => {}, 1000));
  claude.setInternalPermissionMode = mock(() => undefined);
  claude.setInternalThinkingMode = mock(() => undefined);
  claude.setInternalClaudeThinkingMode = mock(() => undefined);
  claude.failClaudeInternalSession = mock((agentSessionId, chatId, errorMessage, metadata) => {
    claude.emitProcessing(chatId, false);
    claude.emitFailed(chatId, errorMessage, metadata);
  });
  return claude;
}

describe('createClaudeAgent', () => {
  it('emits a failed event when fire-and-forget startup rejects', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-claude-agent-'));
    const startError = new Error('missing claude binary');
    const claude = createClaudeStub(startError);
    const agent = createClaudeAgent(claude);
    const processingEvents = [];
    const failed = new Promise((resolve) => {
      agent.runtime.onFailed((chatId, errorMessage, metadata) => resolve({
        chatId,
        errorMessage,
        metadata,
      }));
    });
    agent.runtime.onProcessing((chatId, isProcessing) => {
      processingEvents.push({ chatId, isProcessing });
    });

    const started = await agent.runtime.startSession({
      chatId: 'chat-1',
      command: 'hello',
      projectPath,
      model: 'sonnet',
      permissionMode: 'default',
      thinkingMode: 'none',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    });
    const failure = await failed;

    expect(claude.startClaudeCliSession).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: started.agentSessionId,
      chatId: 'chat-1',
    }));
    expect(claude.failClaudeInternalSession).toHaveBeenCalledWith(
      started.agentSessionId,
      'chat-1',
      'missing claude binary',
      {
        clientRequestId: 'req-1',
        commandType: 'chat-start',
        turnId: 'turn-1',
      },
    );
    expect(failure).toEqual({
      chatId: 'chat-1',
      errorMessage: 'missing claude binary',
      metadata: {
        clientRequestId: 'req-1',
        commandType: 'chat-start',
        turnId: 'turn-1',
      },
    });
    expect(processingEvents).toContainEqual({ chatId: 'chat-1', isProcessing: false });

    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('emits an exact terminal when startup admission is aborted after detachment', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-claude-agent-abort-'));
    try {
      let rejectStart;
      const claude = createClaudeStub(new Error('unused'));
      claude.startClaudeCliSession = mock(() => new Promise((_resolve, reject) => {
        rejectStart = reject;
      }));
      const agent = createClaudeAgent(claude);
      const controller = new AbortController();
      const failed = new Promise((resolve) => {
        agent.runtime.onFailed((chatId, errorMessage, metadata) => resolve({
          chatId,
          errorMessage,
          metadata,
        }));
      });

      await agent.runtime.startSession({
        chatId: 'chat-1',
        command: 'hello',
        projectPath,
        model: 'sonnet',
        permissionMode: 'default',
        thinkingMode: 'none',
        clientRequestId: 'req-abort',
        turnId: 'turn-abort',
        executionAdmission: {
          signal: controller.signal,
          markStarted: mock(() => undefined),
        },
      });
      const reason = new Error('server is shutting down');
      controller.abort(reason);
      rejectStart(reason);

      await expect(failed).resolves.toEqual({
        chatId: 'chat-1',
        errorMessage: 'server is shutting down',
        metadata: {
          clientRequestId: 'req-abort',
          commandType: 'chat-start',
          turnId: 'turn-abort',
        },
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
