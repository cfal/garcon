import { test } from 'bun:test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { verifyDisplayBrowser, verifyDisplayReconnectGap } from '../../support/transcript-display-browser-scenario.js';
import { verifyFailedDisplayControlsAndLiveWire, verifyOptimisticProjectionLag } from '../../support/transcript-display-live-browser.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

test('certified display stays bounded through deep navigation, pattern changes, recall and resizing', async () => {
  await withChromiumFixture('transcript-display', fixture => verifyDisplayBrowser(fixture, 'chromium'));
}, 180_000);

test('recovers a 40000-pair connection gap without transferring collapsed member bodies', async () => {
  await withChromiumFixture('display-large-reconnect-gap', fixture => verifyDisplayReconnectGap(fixture, 'chromium'));
}, 180_000);

test('optimistic text remains exactly once from commit through delayed display admission', async () => {
  await withChromiumFixture('transcript-display-optimistic-lag', verifyOptimisticProjectionLag);
}, 120_000);

test('permissions remain actionable without a display window and live collapsed bodies stay off the wire', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  try {
    await withChromiumFixture('transcript-display-failed-controls-live-wire',
      fixture => verifyFailedDisplayControlsAndLiveWire(fixture, environment), undefined,
      { serverEnvironment: environment.serverEnvironment });
  } finally { environment.dispose(); }
}, 180_000);
