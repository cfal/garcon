import { describe, expect, it, mock } from 'bun:test';

import { AgentSwitchError, AgentSwitchService } from '../agent-switch-service.ts';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';
import { UserMessage } from '../../../common/chat-types.js';

// Builds a fully mocked AgentSwitchService with a real KeyedPromiseLock so the
// switch runs through its serialization path. Overrides tune per-test behavior.
function makeService(overrides = {}) {
  const entry = {
    id: '1',
    agentId: 'claude',
    agentSessionId: 'agent-1',
    nativePath: '/tmp/agent-1.jsonl',
    projectPath: '/repo',
    model: 'opus',
    apiProviderId: null,
    modelEndpointId: null,
    permissionMode: 'default',
    thinkingMode: 'off',
    claudeThinkingMode: 'off',
    ampAgentMode: 'default',
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
  };

  const loadMessages = overrides.loadMessages
    ?? mock(() => Promise.resolve([new UserMessage('2026-07-07T00:00:00.000Z', 'prior turn')]));
  const isRunning = overrides.isRunning ?? mock(() => false);
  const fromAgent = {
    label: 'Claude',
    runtime: { isRunning },
    transcript: { loadMessages },
  };
  const directory = {
    get: mock((agentId) => (agentId === entry.agentId ? fromAgent : null)),
  };

  const endpointResolver = {
    resolveSelection: mock((input) => ({
      model: input.model,
      apiProviderId: input.apiProviderId ?? null,
      endpointId: input.modelEndpointId ?? null,
      protocol: null,
      isLocal: false,
    })),
  };

  const carryOver = {
    getMessages: overrides.carryOverMessages ?? mock(() => []),
    appendSegment: mock(() => undefined),
  };

  const service = new AgentSwitchService({
    registry,
    directory,
    endpointResolver,
    carryOver,
    chatMutationLock: overrides.lock ?? new KeyedPromiseLock(),
  });

  return { service, registry, directory, endpointResolver, carryOver, loadMessages, isRunning, sessions };
}

describe('AgentSwitchService', () => {
  it('snapshots the source transcript and stages a fresh session under the target', async () => {
    const { service, registry, carryOver, loadMessages } = makeService();

    const updated = await service.switchAgentModel({
      chatId: '1',
      agentId: 'codex',
      model: 'gpt-5',
    });

    // Loads the outgoing native transcript for the source chat.
    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(loadMessages.mock.calls[0][1]).toEqual({ chatId: '1' });

    // Appends the outgoing agent id and its messages to carry-over.
    expect(carryOver.appendSegment).toHaveBeenCalledTimes(1);
    const [segmentChatId, segment] = carryOver.appendSegment.mock.calls[0];
    expect(segmentChatId).toBe('1');
    expect(segment.agentId).toBe('claude');
    expect(segment.messages.length).toBe(1);

    // Registry is patched to the target agent with a cleared native session and
    // a non-empty carried-context seed, plus normalized modes.
    expect(registry.updateChat).toHaveBeenCalledTimes(1);
    const [, patch] = registry.updateChat.mock.calls[0];
    expect(patch.agentId).toBe('codex');
    expect(patch.agentSessionId).toBeNull();
    expect(patch.nativePath).toBeNull();
    expect(typeof patch.carryOverContext).toBe('string');
    expect(patch.carryOverContext.length).toBeGreaterThan(0);
    expect(patch.permissionMode).toBeDefined();
    expect(patch.thinkingMode).toBeDefined();
    expect(patch.claudeThinkingMode).toBeDefined();
    expect(patch.ampAgentMode).toBeDefined();

    expect(updated.agentId).toBe('codex');
  });

  it('refuses to switch while the outgoing turn is running', async () => {
    const { service, registry, carryOver } = makeService({ isRunning: mock(() => true) });

    let error;
    try {
      await service.switchAgentModel({ chatId: '1', agentId: 'codex', model: 'gpt-5' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AgentSwitchError);
    expect(error.message).toBe('Stop the current turn before switching agents.');
    expect(error.status).toBe(409);
    expect(error.code).toBe('SESSION_BUSY');

    // A running turn short-circuits before any mutation or snapshot.
    expect(registry.updateChat).not.toHaveBeenCalled();
    expect(carryOver.appendSegment).not.toHaveBeenCalled();
  });

  it('clears Codex ultra thinking when switching to another agent', async () => {
    const { service, registry } = makeService({
      entry: { agentId: 'codex', thinkingMode: 'ultra' },
    });

    await service.switchAgentModel({ chatId: '1', agentId: 'claude', model: 'opus' });

    expect(registry.updateChat.mock.calls[0][1].thinkingMode).toBe('none');
  });

  it('reads carry-over and skips a duplicate segment on a chained switch', async () => {
    const carriedMessages = [new UserMessage('2026-07-07T00:00:00.000Z', 'earlier chained turn')];
    const { service, carryOver, loadMessages } = makeService({
      entry: { agentSessionId: null, nativePath: null },
      carryOverMessages: mock(() => carriedMessages),
    });

    const updated = await service.switchAgentModel({
      chatId: '1',
      agentId: 'codex',
      model: 'gpt-5',
    });

    // No native session means history comes from carry-over, not the transcript.
    expect(loadMessages).not.toHaveBeenCalled();
    expect(carryOver.getMessages).toHaveBeenCalledWith('1');

    // A chained switch already has its history staged, so it must not re-append.
    expect(carryOver.appendSegment).not.toHaveBeenCalled();

    expect(updated.agentId).toBe('codex');
    expect(updated.carryOverContext).toContain('earlier chained turn');
  });

  it('serializes concurrent switches on the same chat via the shared lock', async () => {
    // Blocking the first switch inside loadMessages proves the second waits: if
    // the lock were bypassed the second switch would reach updateChat while the
    // first is still parked at the gate.
    const order = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const loadMessages = mock(async () => {
      order.push('first-load-start');
      await firstGate;
      order.push('first-load-end');
      return [];
    });
    const { service, registry } = makeService({ loadMessages });
    const baseUpdate = registry.updateChat.getMockImplementation();
    registry.updateChat.mockImplementation((chatId, patch) => {
      order.push(`update:${patch.agentId}`);
      return baseUpdate(chatId, patch);
    });

    const first = service.switchAgentModel({ chatId: '1', agentId: 'codex', model: 'gpt-5' });
    const second = service.switchAgentModel({ chatId: '1', agentId: 'amp', model: 'sonnet' });

    // Drain the microtask queue so the first switch reaches its blocking load;
    // the second must still be parked behind the lock, never reaching updateChat.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['first-load-start']);
    releaseFirst();
    await Promise.all([first, second]);
    // The first fully completes (through updateChat) before the second begins.
    expect(order).toEqual(['first-load-start', 'first-load-end', 'update:codex', 'update:amp']);
  });
});
