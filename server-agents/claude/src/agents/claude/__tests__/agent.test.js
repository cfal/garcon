import { describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { AgentEventEmitterRuntime } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { ClaudeExecution } from '../execution.ts';
import { createClaudeNativePath } from '../native-path.ts';

function createLogger() {
  return {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  };
}

function createClaudeStub(startError) {
  const claude = new AgentEventEmitterRuntime();
  claude.startClaudeCliSession = mock(() => Promise.reject(startError));
  claude.runClaudeTurn = mock(() => Promise.resolve(undefined));
  claude.abortClaudeInternalSession = mock(() => Promise.resolve(false));
  claude.isClaudeInternalSessionRunning = mock(() => false);
  claude.getRunningClaudeInternalSessions = mock(() => []);
  claude.resolveInternalToolApproval = mock(() => undefined);
  claude.setInternalPermissionMode = mock(() => undefined);
  claude.setInternalThinkingMode = mock(() => undefined);
  claude.setInternalClaudeThinkingMode = mock(() => undefined);
  claude.prepareClaudeProjectPathUpdate = mock(() => Promise.resolve());
  claude.failClaudeInternalSession = mock((agentSessionId, chatId, errorMessage, metadata) => {
    claude.emitProcessing(chatId, false);
    claude.emitFailed(chatId, errorMessage, metadata);
  });
  return claude;
}

function createExecution(runtime, configHomeDir) {
  const logger = createLogger();
  return new ClaudeExecution({
    apiProviders: { resolveCredential: mock(() => Promise.resolve(null)) },
  }, runtime, createPathNativeSessionCodec('claude'), logger, {
    binary: () => 'claude',
    anthropicApiKey: () => null,
    anthropicBaseUrl: () => null,
    configHomeDir: () => configHomeDir,
  });
}

function startRequest(projectPath, signal = new AbortController().signal) {
  return {
    chatId: 'chat-1',
    projectPath,
    model: 'sonnet',
    permissionMode: 'default',
    thinkingMode: 'none',
    settings: {
      ownerId: 'claude',
      schemaVersion: 1,
      values: { claudeThinkingMode: 'auto' },
    },
    endpoint: null,
    operation: {
      clientRequestId: 'req-1',
      clientMessageId: null,
      commandType: 'chat-start',
      turnId: 'turn-1',
    },
    admission: {
      signal,
      markStarted: mock(() => undefined),
      markAbortable: mock(() => undefined),
    },
    prompt: 'hello',
    attachments: [],
    carriedContext: null,
  };
}

describe('ClaudeExecution', () => {
  it('emits a failed event when fire-and-forget startup rejects', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-claude-agent-'));
    try {
      const startError = new Error('missing claude binary');
      const claude = createClaudeStub(startError);
      const execution = createExecution(claude, projectPath);
      const failed = new Promise((resolve) => {
        execution.subscribe((event) => {
          if (event.type === 'failed') resolve(event);
        });
      });

      const started = await execution.start(startRequest(projectPath));
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
      expect(failure).toMatchObject({
        type: 'failed',
        chatId: 'chat-1',
        error: { code: 'PROVIDER_FAILURE', message: 'missing claude binary' },
        operation: startRequest(projectPath).operation,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('emits an exact terminal when startup admission is aborted after detachment', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-claude-agent-abort-'));
    try {
      let rejectStart;
      const claude = createClaudeStub(new Error('unused'));
      claude.startClaudeCliSession = mock(() => new Promise((_resolve, reject) => {
        rejectStart = reject;
      }));
      const execution = createExecution(claude, projectPath);
      const controller = new AbortController();
      const failed = new Promise((resolve) => {
        execution.subscribe((event) => {
          if (event.type === 'failed') resolve(event);
        });
      });

      await execution.start(startRequest(projectPath, controller.signal));
      const reason = new Error('server is shutting down');
      controller.abort(reason);
      rejectStart(reason);

      await expect(failed).resolves.toMatchObject({
        type: 'failed',
        chatId: 'chat-1',
        error: { code: 'PROVIDER_FAILURE', message: 'server is shutting down' },
        operation: startRequest(projectPath).operation,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('returns a relocated native session while preserving the endpoint binding', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-claude-relocation-'));
    const configHomeDir = path.join(rootDirectory, 'config');
    const previousProjectPath = path.join(rootDirectory, 'project-a');
    const nextProjectPath = path.join(rootDirectory, 'project-b');
    await fs.mkdir(previousProjectPath, { recursive: true });
    await fs.mkdir(nextProjectPath, { recursive: true });
    const sourcePath = await createClaudeNativePath(
      previousProjectPath,
      'session-1',
      { configHomeDir },
    );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, 'transcript\n');

    try {
      const claude = createClaudeStub(new Error('unused'));
      const execution = createExecution(claude, configHomeDir);
      const preparation = await execution.prepareProjectPathUpdate({
        chat: {
          chatId: 'chat-1',
          agentId: 'claude',
          agentSessionId: 'session-1',
          projectPath: previousProjectPath,
          model: 'sonnet',
          nativeSession: {
            ownerId: 'claude',
            schemaVersion: 1,
            value: {
              path: sourcePath,
              agentSessionId: 'session-1',
              modelEndpointId: 'endpoint-1',
            },
          },
          carryOverRevision: 'carry-1',
          settings: {
            ownerId: 'claude',
            schemaVersion: 1,
            values: { claudeThinkingMode: 'auto' },
          },
        },
        nextProjectPath,
        signal: new AbortController().signal,
      });

      expect(claude.prepareClaudeProjectPathUpdate).toHaveBeenCalledWith({
        chatId: 'chat-1',
        agentSessionId: 'session-1',
        previousProjectPath,
        nextProjectPath,
        nativePath: sourcePath,
      });
      expect(preparation.nativeSession).toMatchObject({
        ownerId: 'claude',
        value: {
          agentSessionId: 'session-1',
          modelEndpointId: 'endpoint-1',
        },
      });
      expect(preparation.nativeSession.value.path).not.toBe(sourcePath);
      expect(await fs.readFile(preparation.nativeSession.value.path, 'utf8')).toBe(
        'transcript\n',
      );

      await preparation.rollback();
      expect(await fs.readFile(sourcePath, 'utf8')).toBe('transcript\n');
    } finally {
      await fs.rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it('does not require a native transcript for an unstarted chat', async () => {
    const claude = createClaudeStub(new Error('unused'));
    const execution = createExecution(claude, '/tmp/config');

    await expect(execution.prepareProjectPathUpdate({
      chat: {
        chatId: 'chat-1',
        agentId: 'claude',
        agentSessionId: null,
        projectPath: '/old',
        model: 'sonnet',
        nativeSession: null,
        carryOverRevision: 'carry-1',
        settings: {
          ownerId: 'claude',
          schemaVersion: 1,
          values: { claudeThinkingMode: 'auto' },
        },
      },
      nextProjectPath: '/next',
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();

    expect(claude.prepareClaudeProjectPathUpdate).not.toHaveBeenCalled();
  });
});
