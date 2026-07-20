import { describe, expect, it, mock } from 'bun:test';
import {
  TranscriptSearchSettingsCoordinator,
  TranscriptSearchSettingsError,
} from '../settings-coordinator.js';

function createHarness(enabled = false) {
  let current = enabled;
  const events = [];
  const settings = {
    getFeatureSettings: () => ({ transcriptSearch: { enabled: current } }),
    setTranscriptSearchEnabled: mock(async (next) => {
      events.push(`persist:${next}`);
      current = next;
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
    harness.settings.setTranscriptSearchEnabled.mockImplementationOnce(async () => {
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
    expect(harness.settings.setTranscriptSearchEnabled).not.toHaveBeenCalled();
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
    expect(harness.settings.setTranscriptSearchEnabled).not.toHaveBeenCalled();
  });
});
