import { expect, test } from 'bun:test';
import { withExpectedConsoleErrors } from '../../integration-tests/support/browser-errors.ts';
import { rejectionOf } from '../../integration-tests/support/promise-assertions.ts';

const allowed = 'Synthetic offline diagnostic';

test.each([0, 1, 3])('a fault window permits %i matching console diagnostics without requiring logging', async count => {
  const errors = [];
  expect(await withExpectedConsoleErrors(errors, [allowed], async () => {
    errors.push(...Array(count).fill(`console.error: ${allowed}`));
    return 'completed';
  })).toBe('completed');
  expect(errors).toEqual([]);
});

test.each([`pageerror: ${allowed}`, 'console.error: Unrelated failure', `console.error: prefix ${allowed}`])(
  'a fault window preserves unexpected errors: %s', async message => {
    const errors = [];
    const failure = await rejectionOf(withExpectedConsoleErrors(errors, [new RegExp(allowed)], async () => {
      errors.push(message);
    }));
    expect(failure.message).toContain('Unexpected browser errors');
    expect(errors).toEqual([message]);
  },
);

test('a fault window cannot consume an earlier error', async () => {
  const errors = [`console.error: ${allowed}`];
  let ran = false;
  const failure = await rejectionOf(withExpectedConsoleErrors(errors, [allowed], async () => { ran = true; }));
  expect(failure.message).toContain('before fault injection');
  expect(ran).toBe(false);
  expect(errors).toHaveLength(1);
});

test('a fault window preserves the scenario failure and diagnostics', async () => {
  const errors = [];
  const failure = new Error('Synthetic assertion failure');
  expect(await rejectionOf(withExpectedConsoleErrors(errors, [allowed], async () => {
    errors.push(`console.error: ${allowed}`);
    throw failure;
  }))).toBe(failure);
  expect(errors).toHaveLength(1);
});
