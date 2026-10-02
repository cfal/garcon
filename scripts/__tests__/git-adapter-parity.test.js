import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { GIT_REQUEST_FIELDS } from '../../common/git-request-validation.js';

test.each([
  ['server/runtime/git/runtime.ts', 'this.#run'],
  ['server/remote/client/remote-git.ts', 'this.#gitCall'],
  ['server/controller/routes/git-executor-service.ts', 'invoke'],
])('%s forwards every Git method with its original arguments', (file, dispatcher) => {
  const source = readFileSync(resolve(import.meta.dir, '../..', file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const forwarded = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer)) {
      const arrow = node.initializer;
      const call = arrow.body;
      if (ts.isCallExpression(call) && call.expression.getText(tree) === dispatcher) {
        const name = node.name.getText(tree);
        expect(ts.isStringLiteral(call.arguments[0])).toBe(true);
        expect(call.arguments[0].text).toBe(name);
        expect(call.arguments.slice(1).map(arg => arg.getText(tree)))
          .toEqual(arrow.parameters.map(param => param.name.getText(tree)));
        forwarded.push(name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  expect(forwarded.sort()).toEqual(Object.keys(GIT_REQUEST_FIELDS).sort());
});
