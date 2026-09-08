import { describe, expect, it, mock } from 'bun:test';
import {
  TranscriptSearchSettingsCoordinator,
  TranscriptSearchSettingsError,
} from '../settings-coordinator.js';

function createHarness(enabled = false) {
  let current = enabled;
  const events = [];
  const settings = {
    getFeatureSettings: () => ({
      transcriptSearch: { enabled: current },
      agentCommands: { enabled: true, chatIdDiscovery: true, sendMessage: true, startAgent: true, resumeAgent: true, schedule: true },
    }),
    confirmDurability: mock(async () => undefined),
    setFeatureSettings: mock(async (patch) => {
      events.push(`persist:${patch.transcriptSearch.enabled}`);
      current = patch.transcriptSearch.enabled;
    }),
  };
  const controller = {
    start: mock(async () => { events.push('start'); }),
    disableAndDelete: mock(async () => { events.push('delete'); }),
  };
  const coordinator = new TranscriptSearchSettingsCoordinator(settings, controller);
  return { coordinator, controller, events, settings };
}

describe('TranscriptSearchSettingsCoordinator', () => {
  it('rolls back provisional storage when enable persistence fails', async () => {
    const harness = createHarness(false);
    harness.settings.setFeatureSettings.mockImplementationOnce(async () => {
      harness.events.push('persist:true');
      throw new Error('disk full');
    });
    await expect(harness.coordinator.setEnabled(true)).rejects.toBeInstanceOf(
      TranscriptSearchSettingsError,
    );
    expect(harness.events).toEqual(['start', 'persist:true', 'delete']);
  });

  it('persists false before deleting the index', async () => {
    const harness = createHarness(true);
    await harness.coordinator.setEnabled(false);
    expect(harness.events).toEqual(['persist:false', 'delete']);
  });

  it('serializes concurrent toggles to the final requested value', async () => {
    const harness = createHarness(false);
    const enable = harness.coordinator.setEnabled(true);
    const disable = harness.coordinator.setEnabled(false);
    await Promise.all([enable, disable]);
    expect(harness.settings.getFeatureSettings().transcriptSearch.enabled).toBe(false);
    expect(harness.events).toEqual(['start', 'persist:true', 'persist:false', 'delete']);
  });

  it('retries cleanup while the durable setting is already disabled', async () => {
    const harness = createHarness(false);
    harness.controller.disableAndDelete.mockImplementationOnce(async () => {
      harness.events.push('delete');
      throw new Error('busy');
    });

    await expect(harness.coordinator.setEnabled(false)).rejects.toMatchObject({
      code: 'TRANSCRIPT_SEARCH_CLEANUP_FAILED',
    });
    await harness.coordinator.setEnabled(false);

    expect(harness.events).toEqual(['delete', 'delete']);
    expect(harness.settings.setFeatureSettings).not.toHaveBeenCalled();
  });

  it('retries admission while the durable setting is already enabled', async () => {
    const harness = createHarness(true);
    harness.controller.start.mockImplementationOnce(async () => {
      harness.events.push('start');
      throw new Error('reader unavailable');
    });

    await expect(harness.coordinator.setEnabled(true)).rejects.toMatchObject({
      code: 'TRANSCRIPT_SEARCH_ENABLE_FAILED',
    });
    await harness.coordinator.setEnabled(true);

    expect(harness.events).toEqual(['start', 'start']);
    expect(harness.settings.setFeatureSettings).not.toHaveBeenCalled();
  });

  for (const [enabled, lifecycle] of [[true, 'start'], [false, 'delete']]) {
    it(`confirms settings durability before the ${lifecycle} same-value lifecycle action`, async () => {
      const harness = createHarness(enabled);
      harness.settings.confirmDurability.mockImplementationOnce(async () => {
        harness.events.push('confirm');
      });

      await harness.coordinator.setEnabled(enabled);

      expect(harness.events).toEqual(['confirm', lifecycle]);
    });
  }

  it('persists a combined feature patch once', async () => {
    const harness = createHarness(false);

    await harness.coordinator.setEnabled(true, {
      agentCommands: { enabled: false, chatIdDiscovery: false, sendMessage: true, startAgent: true, resumeAgent: true, schedule: true },
    });

    expect(harness.settings.setFeatureSettings).toHaveBeenCalledTimes(1);
    expect(harness.settings.setFeatureSettings).toHaveBeenCalledWith({
      transcriptSearch: { enabled: true },
      agentCommands: { enabled: false, chatIdDiscovery: false, sendMessage: true, startAgent: true, resumeAgent: true, schedule: true },
    });
  });

  it('rebuilds an enabled derived index without changing its durable setting', async () => {
    const harness = createHarness(true);

    await harness.coordinator.rebuild();

    expect(harness.events).toEqual(['delete', 'start']);
    expect(harness.settings.setFeatureSettings).not.toHaveBeenCalled();
  });

  it('rejects rebuild while disabled before changing index lifecycle', async () => {
    const harness = createHarness(false);

    await expect(harness.coordinator.rebuild()).rejects.toMatchObject({
      code: 'TRANSCRIPT_SEARCH_DISABLED',
    });

    expect(harness.controller.disableAndDelete).not.toHaveBeenCalled();
    expect(harness.controller.start).not.toHaveBeenCalled();
  });

  it('reports rebuild admission failures through the existing typed error', async () => {
    const harness = createHarness(true);
    harness.controller.start.mockImplementationOnce(async () => {
      harness.events.push('start');
      throw new Error('reader unavailable');
    });

    await expect(harness.coordinator.rebuild()).rejects.toMatchObject({
      code: 'TRANSCRIPT_SEARCH_ENABLE_FAILED',
    });
    expect(harness.events).toEqual(['delete', 'start']);
  });

  it('keeps an additional feature patch when disabled cleanup fails', async () => {
    const harness = createHarness(false);
    harness.controller.disableAndDelete.mockImplementationOnce(async () => {
      harness.events.push('delete');
      throw new Error('busy');
    });

    await expect(harness.coordinator.setEnabled(false, {
      agentCommands: { enabled: false, chatIdDiscovery: false, sendMessage: true, startAgent: true, resumeAgent: true, schedule: true },
    })).rejects.toMatchObject({ code: 'TRANSCRIPT_SEARCH_CLEANUP_FAILED' });

    expect(harness.events).toEqual(['persist:false', 'delete']);
    expect(harness.settings.setFeatureSettings).toHaveBeenCalledWith({
      transcriptSearch: { enabled: false },
      agentCommands: { enabled: false, chatIdDiscovery: false, sendMessage: true, startAgent: true, resumeAgent: true, schedule: true },
    });
  });
});
