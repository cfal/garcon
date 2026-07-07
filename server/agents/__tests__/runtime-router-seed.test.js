import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { AgentRuntimeRouter } from '../runtime-router.ts';
import { SEED_CONTEXT_OPEN } from '../shared/transcript-seed.ts';

// Drives the real AgentRuntimeRouter with a mocked agent runtime so the
// seed-composition path in runAgentTurn is exercised end to end. A real project
// directory lets file-mention resolution run against actual files.
let projectDir;

function makeRouter(overrides = {}) {
  const entry = {
    id: '1',
    agentId: 'codex',
    agentSessionId: null,
    nativePath: null,
    projectPath: projectDir,
    model: 'gpt-5',
    apiProviderId: null,
    modelEndpointId: null,
    permissionMode: 'default',
    thinkingMode: 'off',
    claudeThinkingMode: 'off',
    ampAgentMode: 'default',
    carryOverContext: overrides.carryOverContext,
    ...overrides.entry,
  };
  const sessions = new Map([['1', entry]]);
  const registry = {
    getChat: mock((chatId) => sessions.get(chatId) ?? null),
    updateChat: mock((chatId, patch) => {
      const current = sessions.get(chatId);
      if (!current) return null;
      const next = { ...current, ...patch };
      sessions.set(chatId, next);
      return next;
    }),
    getChatByAgentSessionId: mock(() => null),
  };

  const startSession = overrides.startSession
    ?? mock(() => Promise.resolve({ agentSessionId: 'agent-new', nativePath: '/tmp/agent-new.jsonl' }));
  const agent = {
    id: 'codex',
    runtime: {
      startSession,
      runTurn: mock(() => Promise.resolve(undefined)),
      isRunning: mock(() => false),
      abort: mock(() => Promise.resolve(true)),
      getRunningSessions: mock(() => []),
    },
  };
  const directory = {
    require: mock((agentId) => {
      if (agentId !== agent.id) throw new Error(`Unsupported agent: ${agentId}`);
      return agent;
    }),
    get: mock((agentId) => (agentId === agent.id ? agent : null)),
    list: mock(() => [agent]),
  };

  const endpointResolver = {
    resolveSelection: mock((input) => ({
      model: input.model,
      apiProviderId: input.apiProviderId ?? null,
      endpointId: input.modelEndpointId ?? null,
      protocol: null,
      isLocal: false,
    })),
    resolveEndpointReference: mock(() => null),
  };

  const events = {
    trackTurn: mock(() => undefined),
    clearTurn: mock(() => undefined),
  };

  const router = new AgentRuntimeRouter({ registry, directory, endpointResolver, events });
  return { router, registry, startSession, sessions };
}

describe('AgentRuntimeRouter seed branch', () => {
  beforeEach(async () => {
    projectDir = path.join(os.tmpdir(), `garcon-runtime-router-${randomUUID()}`);
    await fs.mkdir(projectDir, { recursive: true });
    // A real file so the user command's @-mention resolves to content.
    await fs.writeFile(path.join(projectDir, 'notes.txt'), 'USER FILE BODY', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('seeds the fresh session with the carried context and keeps it opaque', async () => {
    // The seed references a file that also exists on disk; it must NOT be
    // expanded because the seed is historical text passed with skipFileMentions.
    await fs.writeFile(path.join(projectDir, 'secret.txt'), 'SECRET FILE BODY', 'utf8');
    const carryOverContext = `${SEED_CONTEXT_OPEN}\nUser: earlier turn mentioning @secret.txt\n</carried-context>`;
    const { router, registry, startSession } = makeRouter({ carryOverContext });

    await router.runAgentTurn('1', 'please read @notes.txt', {
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    });

    expect(startSession).toHaveBeenCalledTimes(1);
    const request = startSession.mock.calls[0][0];

    // Composed command starts with the carried seed context verbatim.
    expect(request.command.startsWith(carryOverContext)).toBe(true);

    // The user command's @-mention is resolved: file body is inlined.
    expect(request.command).toContain('USER FILE BODY');

    // The seed's @-mention stays opaque: its file body is never inlined.
    expect(request.command).not.toContain('SECRET FILE BODY');
    expect(request.command).toContain('@secret.txt');

    // carryOverContext is cleared after seeding so the next turn resumes natively.
    const clearingCall = registry.updateChat.mock.calls.find(
      ([, patch]) => patch && 'carryOverContext' in patch && patch.carryOverContext === null,
    );
    expect(clearingCall).toBeDefined();
  });

  it('passes skipFileMentions so startSession does not re-resolve the seed', async () => {
    // Spy on startSession at the router boundary to capture the flag the seed
    // branch forwards. resolveFileMentions must have run on the user command
    // before startSession, and startSession must be told to skip re-resolution.
    const carryOverContext = `${SEED_CONTEXT_OPEN}\nUser: prior\n</carried-context>`;
    const { router } = makeRouter({ carryOverContext });
    const seen = [];
    const original = router.startSession.bind(router);
    router.startSession = (chatId, command, opts) => {
      seen.push(opts);
      return original(chatId, command, opts);
    };

    await router.runAgentTurn('1', 'follow-up @notes.txt', { turnId: 'turn-1' });

    expect(seen).toHaveLength(1);
    expect(seen[0].skipFileMentions).toBe(true);
  });
});
