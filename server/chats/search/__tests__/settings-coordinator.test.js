import { describe, expect, it, mock } from 'bun:test';
import {
  TranscriptSearchSettingsCoordinator,
  TranscriptSearchSettingsError,
} from '../settings-coordinator.js';

function createHarness(enabled = false) {
  let current = enabled;
  let chatIdDiscoveryEnabled = true;
  const events = [];
  const settings = {
    getFeatureSettings: () => ({
      transcriptSearch: { enabled: current },
      chatIdDiscovery: { enabled: chatIdDiscoveryEnabled },
    }),
    setFeatureSettings: mock(async (patch) => {
      if (patch.transcriptSearch) {
        events.push(`persist:${patch.transcriptSearch.enabled}`);
        current = patch.transcriptSearch.enabled;
      }
      if (patch.chatIdDiscovery) {
        events.push(`persist:chat-id:${patch.chatIdDiscovery.enabled}`);
        chatIdDiscoveryEnabled = patch.chatIdDiscovery.enabled;
      }
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

  it('does not persist an additional feature when disabled cleanup fails', async () => {
    const harness = createHarness(false);
    harness.controller.disableAndDelete.mockImplementationOnce(async () => {
      harness.events.push('delete');
      throw new Error('busy');
    });

    await expect(harness.coordinator.setEnabled(false, {
      chatIdDiscovery: { enabled: false },
    })).rejects.toMatchObject({ code: 'TRANSCRIPT_SEARCH_CLEANUP_FAILED' });

    expect(harness.settings.setFeatureSettings).not.toHaveBeenCalled();
    expect(harness.settings.getFeatureSettings().chatIdDiscovery.enabled).toBe(true);
  });

  it('defers an additional feature until transition cleanup succeeds', async () => {
    const harness = createHarness(true);
    harness.controller.disableAndDelete.mockImplementationOnce(async () => {
      harness.events.push('delete');
      throw new Error('busy');
    });

    await expect(harness.coordinator.setEnabled(false, {
      chatIdDiscovery: { enabled: false },
    })).rejects.toMatchObject({ code: 'TRANSCRIPT_SEARCH_CLEANUP_FAILED' });

    expect(harness.settings.setFeatureSettings).toHaveBeenCalledTimes(1);
    expect(harness.settings.setFeatureSettings).toHaveBeenCalledWith({
      transcriptSearch: { enabled: false },
    });
    expect(harness.settings.getFeatureSettings().chatIdDiscovery.enabled).toBe(true);
  });

  it('persists a combined disable in its required two-phase order', async () => {
    const harness = createHarness(true);

    await harness.coordinator.setEnabled(false, {
      chatIdDiscovery: { enabled: false },
    });

    expect(harness.events).toEqual([
      'persist:false',
      'delete',
      'persist:chat-id:false',
    ]);
    expect(harness.settings.setFeatureSettings.mock.calls).toEqual([
      [{ transcriptSearch: { enabled: false } }],
      [{ chatIdDiscovery: { enabled: false } }],
    ]);
    expect(harness.settings.getFeatureSettings()).toEqual({
      transcriptSearch: { enabled: false },
      chatIdDiscovery: { enabled: false },
    });
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

  it('persists an additional feature in the same mutation', async () => {
    const harness = createHarness(false);
    await harness.coordinator.setEnabled(true, {
      chatIdDiscovery: { enabled: false },
    });

    expect(harness.settings.setFeatureSettings).toHaveBeenCalledWith({
      transcriptSearch: { enabled: true },
      chatIdDiscovery: { enabled: false },
    });
    expect(harness.settings.setFeatureSettings).toHaveBeenCalledTimes(1);
  });
});
