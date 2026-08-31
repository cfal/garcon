import { describe, expect, it, mock } from 'bun:test';
import { ApiProviderEndpointResolver } from '../../api-providers/endpoint-resolver.ts';
import { AgentSessionSettingsService } from '../session-settings-service.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for settings transaction state');
}

function createFixture(overrides = {}) {
  const events = [];
  const initial = {
    id: 'chat-1',
    agentId: 'codex',
    agentSessionId: 'thread-1',
    projectPath: '/repo',
    model: 'model-a',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'default',
    thinkingMode: 'none',
    agentSettingsById: {
      codex: { ownerId: 'codex', schemaVersion: 2, values: { codexFastMode: 'on' } },
    },
  };
  let entry = structuredClone(initial);
  let activeHolds = 0;
  const apply = overrides.apply ?? mock(async () => undefined);
  const updateChat = overrides.updateChat ?? mock(async (_chatId, patch) => {
    entry = { ...entry, ...patch };
    return entry;
  });
  const service = new AgentSessionSettingsService({
    registry: {
      getChat: () => entry,
      updateChat,
    },
    directory: {
      require: () => ({
        descriptor: { id: 'codex' },
        endpoints: null,
        sessionConfiguration: { apply },
        settings: {
          defaults: () => ({
            ownerId: 'codex',
            schemaVersion: 2,
            values: { codexFastMode: 'off' },
          }),
          parse: (settings) => settings,
          applyPatch: (settings, patch) => ({
            ...settings,
            values: { ...settings.values, ...patch },
          }),
        },
      }),
    },
    endpointResolver: new ApiProviderEndpointResolver(() => []),
    executionBarrier: {
      async runWithAutomaticDispatchSuppressed(_chatId, operation) {
        activeHolds += 1;
        events.push(`hold-enter:${activeHolds}`);
        try {
          return await operation();
        } finally {
          events.push(`hold-exit:${activeHolds}`);
          activeHolds -= 1;
        }
      },
    },
  });
  return {
    service,
    events,
    apply,
    updateChat,
    initial,
    getEntry: () => entry,
    setEntry: (next) => { entry = next; },
    getActiveHolds: () => activeHolds,
  };
}

describe('AgentSessionSettingsService automatic dispatch barrier', () => {
  it('holds dispatch through live apply and durable persistence', async () => {
    const live = deferred();
    const flush = deferred();
    const fixture = createFixture({
      apply: mock(async () => {
        fixture.events.push('live-start');
        await live.promise;
        fixture.events.push('live-finish');
      }),
      updateChat: mock(async (_chatId, patch) => {
        fixture.events.push('flush-start');
        await flush.promise;
        fixture.setEntry({ ...fixture.getEntry(), ...patch });
        fixture.events.push('flush-finish');
        return fixture.getEntry();
      }),
    });

    const updating = fixture.service.updateSessionSettings('chat-1', {
      agentSettingsPatch: { codexFastMode: 'off' },
    });
    await waitFor(() => fixture.events.includes('live-start'));
    expect(fixture.events).toEqual(['hold-enter:1', 'live-start']);
    live.resolve();
    await waitFor(() => fixture.events.includes('flush-start'));
    expect(fixture.events).toContain('flush-start');
    expect(fixture.events).not.toContain('hold-exit:1');
    flush.resolve();
    await updating;
    expect(fixture.events).toEqual([
      'hold-enter:1',
      'live-start',
      'live-finish',
      'flush-start',
      'flush-finish',
      'hold-exit:1',
    ]);
  });

  it('releases after live rejection without persisting', async () => {
    const failure = new Error('live update failed');
    const fixture = createFixture({ apply: mock(async () => { throw failure; }) });

    await expect(fixture.service.updateSessionSettings('chat-1', {
      agentSettingsPatch: { codexFastMode: 'off' },
    })).rejects.toBe(failure);

    expect(fixture.updateChat).not.toHaveBeenCalled();
    expect(fixture.events).toEqual(['hold-enter:1', 'hold-exit:1']);
  });

  it('releases only after a failed flush has restored the prior entry', async () => {
    const failure = new Error('flush failed');
    const fixture = createFixture({
      updateChat: mock(async (_chatId, patch) => {
        const previous = fixture.getEntry();
        fixture.setEntry({ ...previous, ...patch });
        fixture.setEntry(previous);
        throw failure;
      }),
    });

    await expect(fixture.service.updateSessionSettings('chat-1', {
      agentSettingsPatch: { codexFastMode: 'off' },
    })).rejects.toBe(failure);

    expect(fixture.getEntry()).toEqual(fixture.initial);
    expect(fixture.events.at(-1)).toBe('hold-exit:1');
  });

  it('retains overlapping holds while the keyed mutation lock preserves order', async () => {
    const first = deferred();
    const applied = [];
    const fixture = createFixture({
      apply: mock(async (_sessionId, configuration) => {
        applied.push(configuration.settings.values.codexFastMode);
        if (applied.length === 1) await first.promise;
      }),
    });

    const on = fixture.service.updateSessionSettings('chat-1', {
      agentSettingsPatch: { codexFastMode: 'on' },
    });
    const off = fixture.service.updateSessionSettings('chat-1', {
      agentSettingsPatch: { codexFastMode: 'off' },
    });
    await waitFor(() => fixture.getActiveHolds() === 2 && applied.length === 1);

    expect(fixture.getActiveHolds()).toBe(2);
    expect(applied).toEqual(['on']);
    first.resolve();
    await Promise.all([on, off]);
    expect(applied).toEqual(['on', 'off']);
    expect(fixture.getActiveHolds()).toBe(0);
    expect(fixture.getEntry().agentSettingsById.codex.values.codexFastMode).toBe('off');
  });
});
