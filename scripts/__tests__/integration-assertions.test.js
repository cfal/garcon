import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { rejectionOf, throwingRejectionOf } from '../../integration-tests/support/promise-assertions.ts';

const root = resolve(import.meta.dir, '../..');

test('integration assertions await IO outside Bun promise matchers', () => {
  const violations = [];
  for (const file of new Bun.Glob('integration-tests/{tests,support}/**/*.ts').scanSync(root)) {
    const tree = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && ['resolves', 'rejects'].includes(node.name.text)) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        violations.push(`${file}:${line + 1}: await IO before asserting; use rejectionOf for failures`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  expect(violations).toEqual([]);
});

test('rejection helpers preserve exact values and fail on fulfillment', async () => {
  const error = new Error('synthetic rejection');
  expect(await rejectionOf(Promise.reject(error))).toBe(error);
  expect(await rejectionOf(Promise.reject(undefined))).toBeUndefined();
  expect(await throwingRejectionOf(Promise.reject(error))).toThrow(error);
  for (const helper of [rejectionOf, throwingRejectionOf]) {
    const failure = await rejectionOf(helper(Promise.resolve('unexpected success')));
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Expected the promise to reject, but it resolved.');
  }
});

test('pending rejection assertions leave concurrent pipe readers responsive', async () => {
  // Reproduces oven-sh/bun#32233 when rejectionOf is replaced with a pending .rejects matcher.
  let asserted = false;
  const expected = Array.from({ length: 34 }, (_, index) => `synthetic-${index}`);
  const commands = expected.map((output) => Bun.$`printf %s ${output}`.quiet());
  const assertions = commands.map(async (command) => {
    await command;
    if (asserted) return;
    asserted = true;
    const error = new Error('synthetic rejection');
    const pending = new Promise((_, reject) => setImmediate(() => reject(error)));
    expect(await rejectionOf(pending)).toBe(error);
  });
  const results = await Promise.all(commands);
  await Promise.all(assertions);
  expect(asserted).toBe(true);
  expect(results.map(result => result.stdout.toString())).toEqual(expected);
});
