import { test } from 'bun:test';
import { webkit } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { verifyCombinedAppend } from '../../support/transcript-display-combined-append.js';

for (const width of [1440, 390]) {
  test(`WebKit grows the final collapsed edit group in place and keeps bottom following at ${width}px`, async () => {
    const environment = await startScriptedClaudeTestEnvironment();
    try {
      const browser = await webkit.launch({ headless: true });
      try {
        await withChromiumFixture(`webkit-display-combined-append-${width}`, fixture => fixture.withExpectedConsoleErrors([
          'Viewport argument key "interactive-widget" not recognized and ignored.',
        ], () => verifyCombinedAppend(fixture, environment, 'webkit', width)),
        undefined, { serverEnvironment: environment.serverEnvironment }, browser);
      } finally { await browser.close(); }
    } finally { environment.dispose(); }
  }, 180_000);
}
