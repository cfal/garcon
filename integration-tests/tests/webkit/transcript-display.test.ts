import { test } from 'bun:test';
import { webkit } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { verifyDisplayBrowser, verifyDisplayReconnectGap } from '../../support/transcript-display-browser-scenario.js';
import { verifyFailedDisplayControlsAndLiveWire, verifyOptimisticProjectionLag } from '../../support/transcript-display-live-browser.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

test('WebKit certified display preserves bounded navigation, settings, recall and compact geometry', async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    await withChromiumFixture('webkit-transcript-display', fixture => fixture.withExpectedConsoleErrors([
      'Viewport argument key "interactive-widget" not recognized and ignored.',
    ], () => verifyDisplayBrowser(fixture, 'webkit')), undefined, {}, browser);
  } finally { await browser.close(); }
}, 180_000);

test('WebKit recovers a 40000-pair connection gap without collapsed member bodies', async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    await withChromiumFixture('webkit-display-large-reconnect-gap', fixture => verifyDisplayReconnectGap(fixture, 'webkit'), undefined, {}, browser);
  } finally { await browser.close(); }
}, 180_000);

test('WebKit keeps optimistic text through delayed display admission', async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    await withChromiumFixture('webkit-display-optimistic-lag', fixture => fixture.withExpectedConsoleErrors([
      'Viewport argument key "interactive-widget" not recognized and ignored.',
    ], () => verifyOptimisticProjectionLag(fixture)), undefined, {}, browser);
  } finally { await browser.close(); }
}, 120_000);

test('WebKit keeps failed-display permissions actionable and live collapsed bodies off the wire', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  const browser = await webkit.launch({ headless: true });
  try {
    await withChromiumFixture('webkit-display-failed-controls-live-wire', fixture => fixture.withExpectedConsoleErrors([
      'Viewport argument key "interactive-widget" not recognized and ignored.',
    ], () => verifyFailedDisplayControlsAndLiveWire(fixture, environment)), undefined,
    { serverEnvironment: environment.serverEnvironment }, browser);
  } finally { await browser.close(); environment.dispose(); }
}, 180_000);
