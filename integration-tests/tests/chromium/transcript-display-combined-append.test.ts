import { test } from 'bun:test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { verifyCombinedAppend } from '../../support/transcript-display-combined-append.js';

for (const width of [1440, 390]) {
  test(`growing the final collapsed edit group changes only its label and keeps bottom following at ${width}px`, async () => {
    const environment = await startScriptedClaudeTestEnvironment();
    try {
      await withChromiumFixture(`display-combined-append-${width}`,
        fixture => verifyCombinedAppend(fixture, environment, 'chromium', width),
        undefined, { serverEnvironment: environment.serverEnvironment });
    } finally { environment.dispose(); }
  }, 180_000);
}
