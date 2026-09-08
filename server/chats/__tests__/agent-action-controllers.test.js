import { describe, expect, it, mock } from 'bun:test';
import { AgentStartController } from '../agent-start-controller.js';
import { AgentScheduleController } from '../agent-schedule-controller.js';
import { AgentStartSelectionService } from '../../agents/agent-start-selection-service.js';
import { KeyedPromiseLock } from '../../lib/keyed-lock.js';
import { DomainError } from '../../lib/domain-error.js';
import { resolveStartProjectPath } from '../../lib/command-project-path.js';
import { ScheduledPromptCreationOutcomeUnknownError } from '../../scheduled-prompts/scheduler.js';
import { ScheduledPromptDomainError } from '../../scheduled-prompts/store.js';
import { parseGarconCommandResult } from '../../../common/garcon-command-results.js';

const SOURCE = { chatId: '1111111111111111', viewId: '00000000-0000-4000-8000-000000000001', requestOrdinal: 2, runId: 'run-1', at: '2030-01-01T00:00:00.000Z' };
const CHILD = '2222222222222222';
const SCHEDULE = '00000000-0000-4000-8000-000000000002';
const START = { type: 'start-agent', ref: 'task', async: true, fork: false, title: null, agentId: 'test', providerId: null, model: 'test-model', reasoningEffort: null, prompt: 'Synthetic child task' };
const SCHEDULING = { type: 'schedule', firstRun: { type: 'after', minutes: 5 }, intervalMinutes: null, endAtUtc: null, busyBehavior: 'queue', body: '' };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function drain() { for (let i = 0; i < 60; i++) await Promise.resolve(); }

function fixture(options = {}) {
  const parent = { projectPath: '/synthetic/project', permissionMode: 'bypassPermissions' };
  const chats = new Map([[SOURCE.chatId, parent]]);
  let currentView = SOURCE.viewId;
  let enabled = true;
  const replies = [];
  const notices = [];
  const events = [];
  const context = {
    registry: { getChat: (id) => chats.get(id) ?? null },
    notices: {
      existingCurrentView: () => ({ viewId: currentView }),
      appendNotice: mock((_chatId, _viewId, notice) => { events.push('notice'); notices.push(notice); }),
    },
    execution: { deliverServerControlInput: mock(async (chatId, input) => {
      events.push('reply'); replies.push({ chatId, input }); return 'queued';
    }) },
    chatMutationLock: new KeyedPromiseLock(),
    isEnabled: () => enabled,
  };
  const entry = {
    id: 'test', models: [{ value: 'test-model', label: 'Test' }], defaultModel: 'test-model',
    supportedPermissionModes: ['default', 'bypassPermissions'], supportedThinkingModes: ['none', 'high'],
    supportedProtocols: [], acceptsApiProviderEndpoints: false, requiresStrictModelDiscovery: true,
    defaultSettings: { ownerId: 'test', schemaVersion: 1, values: {} },
  };
  const agents = { getAgentCatalogEntry: mock(async () => entry) };
  const selection = new AgentStartSelectionService({ agents, apiProviders: { getCatalog: () => options.providers ?? [] } });
  const commands = { submitAgentCommandStartLocked: mock(async (input) => {
    events.push('start'); chats.set(input.chatId, {}); return { chat: { id: input.chatId }, turnId: 'child-turn' };
  }) };
  const scheduler = { scheduleForChat: mock(async () => {
    events.push('schedule'); return { scheduledPrompt: { id: SCHEDULE, schedule: { type: 'once', nextRunAt: '2030-01-01T00:05:00.000Z' } } };
  }) };
  const start = new AgentStartController({ ...context, selection, commands, turns: { waitForTurnTerminal: mock(async () => null) }, chatIds: options.chatIds ?? { allocate: () => CHILD },
    settings: { getExecutionDefaults: () => ({ global: { permissionMode: 'default', thinkingMode: 'high', agentSettingsById: {} }, byAgent: {} }) } });
  const schedule = new AgentScheduleController({ ...context, scheduler });
  return { parent, chats, context, entry, agents, commands, scheduler, start, schedule, replies, notices, events,
    replaceView: () => { currentView = '00000000-0000-4000-8000-000000000003'; },
    disable: () => { enabled = false; } };
}

describe('assistant action controllers', () => {
  it.each([true, false])('rejects ambiguous provider names with a correlated result and no child admission (endpoint support: %s)', async (acceptsEndpoints) => {
    const f = fixture({ providers: [
      { id: 'first', label: 'Example Proxy', endpoints: [] },
      { id: 'second', label: 'Example Proxy', endpoints: [] },
    ] });
    f.entry.acceptsApiProviderEndpoints = acceptsEndpoints;
    f.start.request(SOURCE, { ...START, providerId: 'Example Proxy' });
    await drain();
    expect(f.commands.submitAgentCommandStartLocked).not.toHaveBeenCalled();
    expect(f.chats.size).toBe(1);
    expect(f.notices).toHaveLength(1);
    expect(f.replies).toHaveLength(1);
    expect(parseGarconCommandResult(f.replies[0].input.content)).toEqual({
      type: 'agent-start-outcome', ref: START.ref, async: true,
      requestViewId: SOURCE.viewId, requestOrdinal: SOURCE.requestOrdinal,
      status: 'rejected', reason: 'ambiguous-provider',
    });
  });

  it('acknowledges allocator exhaustion without admitting child work', async () => {
    const allocate = mock(() => { throw new Error('Synthetic allocator exhaustion'); });
    const f = fixture({ chatIds: { allocate } });
    f.start.request(SOURCE, START);
    await drain();
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(f.commands.submitAgentCommandStartLocked).not.toHaveBeenCalled();
    expect(f.notices).toHaveLength(1);
    expect(f.replies).toHaveLength(1);
    expect(parseGarconCommandResult(f.replies[0].input.content)).toEqual({
      type: 'agent-start-outcome', ref: START.ref, async: true,
      requestViewId: SOURCE.viewId, requestOrdinal: SOURCE.requestOrdinal,
      status: 'rejected', reason: 'action-failed',
    });
  });

  it('inherits current path and explicit bypass permission, uses target defaults and source parentage', async () => {
    const f = fixture();
    const gate = deferred();
    f.agents.getAgentCatalogEntry.mockImplementation(async () => { await gate.promise; return f.entry; });
    f.start.request(SOURCE, START);
    f.parent.projectPath = '/synthetic/current';
    gate.resolve();
    await drain();
    expect(f.agents.getAgentCatalogEntry).toHaveBeenCalledWith('test', { strict: true });
    expect(f.commands.submitAgentCommandStartLocked.mock.calls[0][0]).toMatchObject({
      parentChatId: SOURCE.chatId, chatId: CHILD, projectPath: '/synthetic/current', permissionMode: 'bypassPermissions',
      thinkingMode: 'high', apiProviderId: null, agentSettings: f.entry.defaultSettings, command: START.prompt,
    });
    expect(f.commands.submitAgentCommandStartLocked.mock.calls[0][0]).not.toHaveProperty('tags');
    expect(f.events).toEqual(['start', 'notice', 'reply']);
    expect(f.replies[0].input.receipt).toBeNull();
    expect(parseGarconCommandResult(f.replies[0].input.content)).toMatchObject({ status: 'accepted', chatId: CHILD, requestViewId: SOURCE.viewId, requestOrdinal: 2 });
  });

  it.each([
    ['unsupported-permission-mode', (f) => { f.entry.supportedPermissionModes = ['default']; }, START],
    ['unsupported-reasoning-effort', () => {}, { ...START, reasoningEffort: 'invalid' }],
    ['unknown-model', () => {}, { ...START, model: 'missing' }],
    ['unsupported-agent', (f) => { f.agents.getAgentCatalogEntry.mockResolvedValue(null); }, START],
    ['action-failed', (f) => { f.agents.getAgentCatalogEntry.mockRejectedValue(new Error('discovery failed')); }, START],
  ])('rejects %s before child allocation/admission', async (reason, configure, command) => {
    const f = fixture(); configure(f);
    f.start.request(SOURCE, command); await drain();
    expect(f.commands.submitAgentCommandStartLocked).not.toHaveBeenCalled();
    expect(f.notices[0].detail).toMatchObject({ status: 'rejected', reason });
  });

  it('distinguishes compensated and uncertain retained starts', async () => {
    for (const [error, retained, status] of [
      [new Error('failed start'), false, 'rejected'],
      [new Error('post-admission failure'), true, 'outcome-unknown'],
      [new AggregateError([new Error('rollback flush failed')]), false, 'outcome-unknown'],
    ]) {
      const f = fixture();
      f.commands.submitAgentCommandStartLocked.mockImplementation(async () => { if (retained) f.chats.set(CHILD, {}); throw error; });
      f.start.request(SOURCE, START); await drain();
      expect(f.notices[0].detail.status).toBe(status);
    }
  });

  it.each(['not-found', 'not-a-directory', 'outside-base', 'permission-denied'])('reports an inherited project that is %s without creating a child', async (reason) => {
    const f = fixture();
    f.commands.submitAgentCommandStartLocked.mockImplementation((input) => resolveStartProjectPath(
      input.projectPath, async () => ({ kind: 'unavailable', reason }),
    ));
    f.start.request(SOURCE, START);
    await drain();
    expect(f.notices[0].detail).toMatchObject({ status: 'rejected', reason: 'project-unavailable' });
    expect(f.chats.has(CHILD)).toBe(false);
  });

  it('schedules only the source chat with an exact action wrapper and no configuration fields', async () => {
    const f = fixture();
    f.schedule.request(SOURCE, SCHEDULING); await drain();
    expect(f.scheduler.scheduleForChat).toHaveBeenCalledWith({
      chatId: SOURCE.chatId, firstRun: { type: 'after', minutes: 5 }, intervalMinutes: null,
      endAtUtc: null, busyBehavior: 'queue', prompt: '<garcon-schedule-action />',
    });
    expect(f.events).toEqual(['schedule', 'notice', 'reply']);
    expect(f.notices[0].detail).toMatchObject({ status: 'created', scheduleId: SCHEDULE, intervalMinutes: null });
  });

  it.each([
    [new ScheduledPromptDomainError('SCHEDULED_PROMPT_LIMIT_REACHED', 'limit'), 'failed', 'limit-reached'],
    [new ScheduledPromptDomainError('SCHEDULED_PROMPT_VALIDATION_FAILED', 'invalid'), 'failed', 'invalid-schedule'],
    [new ScheduledPromptCreationOutcomeUnknownError(SCHEDULE, new Error('sync failed')), 'outcome-unknown', undefined],
  ])('reports schedule failure without retry', async (error, status, reason) => {
    const f = fixture(); f.scheduler.scheduleForChat.mockRejectedValue(error);
    f.schedule.request(SOURCE, SCHEDULING); await drain();
    expect(f.scheduler.scheduleForChat).toHaveBeenCalledTimes(1);
    expect(f.notices[0].detail.status).toBe(status);
    expect(f.notices[0].detail.reason).toBe(reason);
  });

  for (const [name, command, action] of [['start', START, 'commands'], ['schedule', SCHEDULING, 'scheduler']]) {
    it(`${name}: rejects new requests permanently after shutdown`, async () => {
      const f = fixture();
      f[name].shutdown();
      f[name].request(SOURCE, command);
      await drain();
      f[name].shutdown();
      f[name].request({ ...SOURCE, requestOrdinal: 4 }, command);
      await drain();
      expect(Object.values(f[action])[0]).not.toHaveBeenCalled();
      expect(f.notices).toEqual([]);
      expect(f.replies).toEqual([]);
    });

    it(`${name}: disabled, stale, deleted, discarded and shutdown sources never mutate`, async () => {
      for (const condition of ['disabled', 'stale', 'deleted', 'discarded', 'shutdown']) {
        const f = fixture();
        if (condition === 'disabled') f.disable();
        if (condition === 'stale') f.replaceView();
        if (condition === 'deleted') f.chats.delete(SOURCE.chatId);
        f[name].request(SOURCE, command);
        if (condition === 'discarded') f[name].discardSource(SOURCE.chatId);
        if (condition === 'shutdown') f[name].shutdown();
        await drain();
        expect(Object.values(f[action])[0]).not.toHaveBeenCalled();
        expect(f.notices).toHaveLength(condition === 'disabled' ? 1 : 0);
      }
    });

    it(`${name}: sequential same-run commands remain separate occurrences`, async () => {
      const f = fixture();
      f[name].request(SOURCE, command); await drain();
      f[name].request({ ...SOURCE, requestOrdinal: 4 }, command); await drain();
      expect(Object.values(f[action])[0]).toHaveBeenCalledTimes(2);
      expect(f.notices.map((n) => n.detail.requestOrdinal)).toEqual([2, 4]);
    });

    it(`${name}: notice and reply failures never repeat or compensate accepted work`, async () => {
      for (const phase of ['notice', 'reply']) {
        const f = fixture();
        if (phase === 'notice') f.context.notices.appendNotice.mockImplementation(() => { throw new Error('notice failed'); });
        else f.context.execution.deliverServerControlInput.mockRejectedValue(new Error('reply failed'));
        f[name].request(SOURCE, command); await drain();
        expect(Object.values(f[action])[0]).toHaveBeenCalledTimes(1);
        expect(f.context.execution.deliverServerControlInput).toHaveBeenCalledTimes(phase === 'notice' ? 0 : 1);
      }
    });

    it(`${name}: reply delivery releases mutation ownership and is abortable`, async () => {
      const f = fixture();
      const delivery = deferred();
      f.context.execution.deliverServerControlInput.mockImplementation(async (_id, _input, signal) => {
        signal.addEventListener('abort', () => delivery.resolve(), { once: true });
        await delivery.promise; return 'queued';
      });
      f[name].request(SOURCE, command); await drain();
      await f.context.chatMutationLock.runExclusive(`chat:${SOURCE.chatId}`, async () => {
        f.replaceView(); f[name].discardSource(SOURCE.chatId);
      });
      await delivery.promise;
      expect(f.notices).toHaveLength(1);
      expect(Object.values(f[action])[0]).toHaveBeenCalledTimes(1);
    });
  }
});
