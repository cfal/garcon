import { expect, test } from 'bun:test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { consumeExpectedBrowserErrors } from '../../support/browser-errors.js';
import { rejectionOf, throwingRejectionOf } from '../../support/promise-assertions.js';

test('expected browser errors require the exact batch, including duplicate counts', () => {
  const errors = ['expected', 'expected', 'unexpected'];
  expect(() => consumeExpectedBrowserErrors(errors, ['expected'])).toThrow('did not match');
  expect(errors).toEqual(['expected', 'expected', 'unexpected']);
  consumeExpectedBrowserErrors(errors, ['unexpected', 'expected', 'expected']);
  expect(errors).toEqual([]);
});

for (const target of ['main', 'peer', 'other-context'] as const) {
  test(`successful scenarios reject uncaught errors on the ${target} page`, async () => {
    expect(await throwingRejectionOf(withChromiumFixture(`browser-policy-${target}`, async fixture => {
      const context = target === 'other-context' ? await fixture.browser.newContext() : fixture.context;
      fixture.watchBrowserErrors(context);
      const page = target === 'main' ? fixture.page : await context.newPage();
      try {
        const captured = page.waitForEvent('pageerror');
        await page.evaluate(() => { setTimeout(() => { throw new Error('Synthetic uncaught browser error'); }, 0); });
        await captured;
      } finally {
        if (context !== fixture.context) await context.close();
      }
    }))).toThrow('pageerror: Synthetic uncaught browser error');
  }, 60_000);
}

test('a fault window does not suppress a later console error', async () => {
  expect(await throwingRejectionOf(withChromiumFixture('browser-policy-console', async fixture => {
    for (const message of ['Synthetic expected failure', 'Synthetic unexpected failure']) {
      const emit = async () => {
        const captured = fixture.page.waitForEvent('console', event => event.type() === 'error');
        await fixture.page.evaluate(message => console.error(message), message);
        await captured;
      };
      if (message === 'Synthetic expected failure') {
        await fixture.withExpectedConsoleErrors([message], emit);
        fixture.assertNoBrowserErrors();
      } else {
        await emit();
      }
    }
  }))).toThrow('console.error: Synthetic unexpected failure');
}, 60_000);

test('an expected error batch permits a successful scenario', async () => {
  expect(await withChromiumFixture('browser-policy-expected', async fixture => {
    const captured = fixture.page.waitForEvent('console', event => event.type() === 'error');
    await fixture.page.evaluate(() => console.error('Synthetic expected failure'));
    await captured;
    fixture.consumeExpectedBrowserErrors(['console.error: Synthetic expected failure']);
    return 'completed';
  })).toBe('completed');
}, 60_000);

test('browser errors do not replace an existing scenario failure', async () => {
  const failure = new Error('Synthetic scenario failure');
  expect(await rejectionOf(withChromiumFixture('browser-policy-original-failure', async fixture => {
    const captured = fixture.page.waitForEvent('console', event => event.type() === 'error');
    await fixture.page.evaluate(() => console.error('Synthetic browser failure'));
    await captured;
    throw failure;
  }))).toBe(failure);
}, 60_000);
