import { expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('fixture cleanup closes the context, browser, controller and temporary root', async () => {
  let contextClosed = false;
  const fixture = await withChromiumFixture('cleanup-contract', async fixture => {
    expect(fixture.browser.isConnected()).toBe(true);
    expect(fixture.integration.garcon.isRunning).toBe(true);
    fixture.context.on('close', () => { contextClosed = true; });
    await access(fixture.integration.dirs.root);
    return fixture;
  }, undefined, { executionBackend: 'in-process' });

  expect(contextClosed).toBe(true);
  expect(fixture.browser.isConnected()).toBe(false);
  expect(fixture.integration.garcon.isRunning).toBe(false);
  expect(await rejectionOf(access(fixture.integration.dirs.root))).toMatchObject({ code: 'ENOENT' });
}, 60_000);
