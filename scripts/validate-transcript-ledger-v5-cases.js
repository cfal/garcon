import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const CASE_ID_PATTERN = /\[(TLV5-[A-Z0-9]+(?:[.-][A-Z0-9]+)*)\]/g;
const INVENTORY_PATH = fileURLToPath(
  new URL('./conformance/transcript-ledger-v5-cases.txt', import.meta.url),
);

export function parseTranscriptConformanceInventory(contents) {
  const ids = contents.split(/\r?\n/u).filter((line) => line.length > 0);
  const errors = [];

  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    errors.push('Inventory case IDs must be unique');
  }

  const sortedIds = [...ids].sort();
  if (ids.some((id, index) => id !== sortedIds[index])) {
    errors.push('Inventory case IDs must be sorted');
  }

  for (const id of ids) {
    if (!/^TLV5-[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/u.test(id)) {
      errors.push(`Invalid inventory case ID: ${id}`);
    }
  }

  return { ids, errors };
}

export function discoverTranscriptConformanceCases(sources) {
  const occurrences = new Map();

  for (const source of sources) {
    if (!source.contents.includes('[TLV5-')) continue;
    const tree = ts.createSourceFile(source.path, source.contents, ts.ScriptTarget.Latest, true);
    let registeredTests = 0;
    function visit(node, bindings) {
      if (ts.isSourceFile(node) || ts.isBlock(node)) {
        const scope = new Map(bindings);
        for (const statement of node.statements) visit(statement, scope);
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          bindTitleValues(declaration.name, titleValues(declaration.initializer, bindings), bindings);
        }
      } else if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        if (isEmptyTable(node.expression)) return;
        const scope = new Map(bindings);
        for (const declaration of node.initializer.declarations) {
          bindTitleValues(declaration.name, titleValues(node.expression, bindings), scope);
        }
        visit(node.statement, scope);
      } else if (ts.isIfStatement(node)) {
        if (node.expression.kind !== ts.SyntaxKind.FalseKeyword) visit(node.thenStatement, bindings);
        if (node.elseStatement && node.expression.kind !== ts.SyntaxKind.TrueKeyword) visit(node.elseStatement, bindings);
      } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
        const call = node.expression;
        const registration = testRegistration(call.expression);
        const callback = call.arguments.find(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
        if (!registration || !callback) return;
        if (registration === 'describe') {
          const before = registeredTests;
          visit(callback.body, bindings);
          if (registeredTests === before) return;
        } else {
          registeredTests++;
        }
        for (const value of titleValues(call.arguments[0], bindings)) {
          if (!ts.isStringLiteralLike(value) && !ts.isTemplateLiteralToken(value)) continue;
          for (const match of value.text.matchAll(CASE_ID_PATTERN)) {
            const locations = occurrences.get(match[1]) ?? [];
            const line = tree.getLineAndCharacterOfPosition(value.getStart(tree)).line + 1;
            locations.push(`${source.path}:${line}`);
            occurrences.set(match[1], locations);
          }
        }
      }
    }
    visit(tree, new Map());
  }

  return occurrences;
}

// Only direct registrations are supported. Aliases and computed registrations do not count.
function testRegistration(expression) {
  expression = unwrapExpression(expression);
  if (!expression) return undefined;
  if (ts.isIdentifier(expression)) {
    return ['test', 'it', 'describe'].includes(expression.text) ? expression.text : undefined;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return ['concurrent', 'serial'].includes(expression.name.text)
      ? testRegistration(expression.expression) : undefined;
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    const method = expression.expression.name.text;
    const argument = unwrapExpression(expression.arguments[0]);
    if (!['each', 'skipIf', 'runIf'].includes(method)
      || (method === 'each' && isEmptyTable(argument))
      || (method === 'skipIf' && argument?.kind === ts.SyntaxKind.TrueKeyword)
      || (method === 'runIf' && argument?.kind === ts.SyntaxKind.FalseKeyword)) return undefined;
    return testRegistration(expression.expression.expression);
  }
  return undefined;
}

function unwrapExpression(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))) {
    node = node.expression;
  }
  return node;
}

function isEmptyTable(node) {
  const value = unwrapExpression(node);
  return value && ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

// Resolves literal title fragments and the repository's table-driven for-of declarations,
// without evaluating test code or treating arbitrary strings/comments as coverage.
function titleValues(node, bindings) {
  node = unwrapExpression(node);
  if (!node) return [];
  if (ts.isStringLiteralLike(node) || ts.isObjectLiteralExpression(node)) return [node];
  if (ts.isIdentifier(node)) return bindings.get(node.text) ?? [];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => titleValues(element, bindings));
  if (ts.isPropertyAccessExpression(node)) {
    return propertyValues(titleValues(node.expression, bindings), node.name.text, bindings);
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head, ...node.templateSpans.flatMap(span => [...titleValues(span.expression, bindings), span.literal])];
  }
  return [];
}

function propertyValues(values, name, bindings) {
  return values.flatMap(value => ts.isObjectLiteralExpression(value)
    ? value.properties.filter(property => ts.isPropertyAssignment(property) && property.name.getText() === name)
      .flatMap(property => titleValues(property.initializer, bindings))
    : []);
}

function bindTitleValues(name, values, bindings) {
  if (ts.isIdentifier(name)) bindings.set(name.text, values);
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      bindTitleValues(element.name, propertyValues(values, (element.propertyName ?? element.name).getText(), bindings), bindings);
    }
  }
}

export function validateTranscriptConformanceInventory(inventoryContents, sources) {
  const inventory = parseTranscriptConformanceInventory(inventoryContents);
  const occurrences = discoverTranscriptConformanceCases(sources);
  const errors = [...inventory.errors];
  const inventoryIds = new Set(inventory.ids);

  for (const id of new Set(inventory.ids)) {
    const locations = occurrences.get(id) ?? [];
    if (locations.length === 0) {
      errors.push(`Missing test case: ${id}`);
    } else if (locations.length > 1) {
      errors.push(`Duplicate test case ${id}: ${locations.join(', ')}`);
    }
  }

  for (const [id, locations] of occurrences) {
    if (!inventoryIds.has(id)) {
      errors.push(`Unregistered test case ${id}: ${locations.join(', ')}`);
    }
  }

  const cases = [...new Set(inventory.ids)].flatMap((id) => {
    const locations = occurrences.get(id) ?? [];
    return locations.length === 1 ? [{ id, location: locations[0] }] : [];
  });

  return { cases, errors };
}

function trackedTestFiles() {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.test.js', '*.test.ts'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Unable to enumerate test files');
  }
  return result.stdout
    .split(/\r?\n/u)
    .filter((path) => path.length > 0 && existsSync(`${repositoryRoot}/${path}`));
}

export function validateRepositoryTranscriptConformanceInventory() {
  const sources = trackedTestFiles().map((path) => ({
    path,
    contents: readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
  }));
  return validateTranscriptConformanceInventory(
    readFileSync(INVENTORY_PATH, 'utf8'),
    sources,
  );
}

function main() {
  const result = validateRepositoryTranscriptConformanceInventory();
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--list')) {
    for (const item of result.cases) console.log(`${item.id} ${item.location}`);
    return;
  }

  console.log(`Validated ${result.cases.length} Transcript Ledger V5 cases`);
}

if (import.meta.main) main();
