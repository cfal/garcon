import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { withTimeout } from '../../support/deferred.js';
import { rejectionOf, throwingRejectionOf } from '../../support/promise-assertions.js';

test('successful Lightpanda scenarios reject reported page errors', async () => {
  expect(await throwingRejectionOf(withE2eFixture('browser-policy-pageerror', async fixture => {
    // Lightpanda 0.3.5 does not forward uncaught timer exceptions over CDP; Chromium covers that boundary.
    fixture.page.emit('pageerror', new Error('Synthetic uncaught browser error'));
  }))).toThrow('pageerror: Synthetic uncaught browser error');
});

test('a Lightpanda fault window does not suppress subsequent console failures', async () => {
  expect(await throwingRejectionOf(withE2eFixture('browser-policy-console', async fixture => {
    for (const message of ['Synthetic expected failure', 'Synthetic unexpected failure']) {
      const emit = async () => {
        const captured = new Promise<void>(resolve => fixture.page.once('console', () => resolve()));
        await fixture.page.evaluate(message => console.error(message), message);
        await withTimeout(captured, 5_000, () => 'Synthetic console error was not captured');
      };
      if (message === 'Synthetic expected failure') {
        await fixture.withExpectedConsoleErrors([message], emit);
        fixture.assertNoBrowserErrors();
      } else {
        await emit();
      }
    }
  }))).toThrow('console.error: Synthetic unexpected failure');
});

test('Lightpanda browser errors preserve an existing scenario failure', async () => {
  const failure = new Error('Synthetic scenario failure');
  expect(await rejectionOf(withE2eFixture('browser-policy-original-failure', async fixture => {
    fixture.page.emit('pageerror', new Error('Synthetic browser failure'));
    throw failure;
  }))).toBe(failure);
});

test('an expected Lightpanda error batch permits a successful scenario', async () => {
  expect(await withE2eFixture('browser-policy-expected', async fixture => {
    const captured = new Promise<void>(resolve => fixture.page.once('console', () => resolve()));
    await fixture.page.evaluate(() => console.error('Synthetic expected failure'));
    await withTimeout(captured, 5_000, () => 'Synthetic console error was not captured');
    fixture.consumeExpectedBrowserErrors(['console.error: Synthetic expected failure']);
    return 'completed';
  })).toBe('completed');
});
