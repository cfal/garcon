import { describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
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
  return {
    startClaudeCliSession: mock((request) => {
      request.onSessionActivated?.();
      return Promise.reject(startError);
    }),
    runClaudeTurn: mock(() => Promise.resolve(undefined)),
    abortClaudeInternalSession: mock(() => Promise.resolve(false)),
    isClaudeInternalSessionRunning: mock(() => false),
    getRunningClaudeInternalSessions: mock(() => []),
    setInternalPermissionMode: mock(() => undefined),
    setInternalThinkingMode: mock(() => undefined),
    setInternalClaudeThinkingMode: mock(() => undefined),
    prepareClaudeProjectPathUpdate: mock(() => Promise.resolve()),
    failClaudeInternalSession: mock((_agentSessionId, _chatId, errorMessage, operation) => {
      operation.publish({
        type: 'run-ended',
        runId: operation.runId,
        outcome: 'failed',
        error: { code: 'PROVIDER_FAILURE', message: errorMessage },
      });
    }),
  };
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
    runId: 'run-1',
    admission: {
      signal,
      markStarted: mock(async () => undefined),
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
      let resolveFailed;
      const failed = new Promise((resolve) => { resolveFailed = resolve; });
      const publish = (event) => {
        if (event.type === 'run-ended' && event.outcome === 'failed') resolveFailed(event);
      };

      const started = await execution.start(startRequest(projectPath), publish);
      const failure = await failed;

      expect(claude.startClaudeCliSession).toHaveBeenCalledWith(expect.objectContaining({
        agentSessionId: started.agentSessionId,
        chatId: 'chat-1',
      }));
      expect(claude.failClaudeInternalSession).toHaveBeenCalledWith(
        started.agentSessionId,
        'chat-1',
        'missing claude binary',
        expect.objectContaining({ runId: 'run-1', publish: expect.any(Function) }),
      );
      expect(failure).toMatchObject({
        type: 'run-ended',
        runId: 'run-1',
        outcome: 'failed',
        error: { code: 'PROVIDER_FAILURE', message: 'missing claude binary' },
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
      claude.startClaudeCliSession = mock((request) => new Promise((_resolve, reject) => {
        request.onSessionActivated?.();
        rejectStart = reject;
      }));
      const execution = createExecution(claude, projectPath);
      const controller = new AbortController();
      let resolveFailed;
      const failed = new Promise((resolve) => { resolveFailed = resolve; });
      const publish = (event) => {
        if (event.type === 'run-ended' && event.outcome === 'failed') resolveFailed(event);
      };

      await execution.start(startRequest(projectPath, controller.signal), publish);
      const reason = new Error('server is shutting down');
      controller.abort(reason);
      rejectStart(reason);

      await expect(failed).resolves.toMatchObject({
        type: 'run-ended',
        runId: 'run-1',
        outcome: 'failed',
        error: { code: 'PROVIDER_FAILURE', message: 'server is shutting down' },
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('[TLV5-L07.07-CLAUDE-UNIT-01] keeps a delayed failed start on the publisher that created it', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-claude-agent-routing-'));
    try {
      let rejectFirst;
      const claude = createClaudeStub(new Error('unused'));
      let starts = 0;
      claude.startClaudeCliSession = mock((request) => {
        request.onSessionActivated?.();
        starts += 1;
        if (starts > 1) return Promise.resolve('replacement-session');
        return new Promise((_resolve, reject) => { rejectFirst = reject; });
      });
      const execution = createExecution(claude, projectPath);
      const firstEvents = [];
      const replacementEvents = [];
      let resolveFailure;
      const failure = new Promise((resolve) => { resolveFailure = resolve; });

      await execution.start(startRequest(projectPath), (event) => {
        firstEvents.push(event);
        if (event.type === 'run-ended') resolveFailure();
      });
      await execution.start(
        { ...startRequest(projectPath), runId: 'run-2' },
        (event) => replacementEvents.push(event),
      );
      rejectFirst(new Error('delayed launch failure'));
      await failure;

      expect(firstEvents.map((event) => event.type)).toEqual(['session', 'run-ended']);
      expect(firstEvents.at(-1)).toMatchObject({
        type: 'run-ended',
        runId: 'run-1',
        outcome: 'failed',
      });
      expect(replacementEvents.map((event) => event.type)).toEqual(['session']);
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
