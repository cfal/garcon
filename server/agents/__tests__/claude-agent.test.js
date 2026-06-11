import { describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createClaudeAgent } from '../claude/index.ts';
import { AgentEventEmitterRuntime } from '../shared/event-emitter-runtime.ts';

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
  claude.failClaudeInternalSession = mock((agentSessionId, chatId, errorMessage) => {
    claude.emitProcessing(chatId, false);
    claude.emitFailed(chatId, errorMessage);
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
      agent.runtime.onFailed((chatId, errorMessage) => resolve({ chatId, errorMessage }));
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
    );
    expect(failure).toEqual({ chatId: 'chat-1', errorMessage: 'missing claude binary' });
    expect(processingEvents).toContainEqual({ chatId: 'chat-1', isProcessing: false });

    await fs.rm(projectPath, { recursive: true, force: true });
  });
});
