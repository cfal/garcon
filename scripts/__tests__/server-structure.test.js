import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '../..');
const server = join(root, 'server');

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'node_modules') return [];
    const filename = join(directory, entry.name);
    return entry.isDirectory() ? sources(filename) : /\.(ts|js)$/.test(filename) ? [filename] : [];
  });
}

function imports(filename) {
  const tree = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result.filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => relative(server, resolve(dirname(filename), specifier)));
}

describe('server ownership boundaries', () => {
  test('keeps only the public entrypoint and package metadata at the server root', () => {
    expect(readdirSync(server).filter((entry) => entry !== 'node_modules').sort()).toEqual([
      'common', 'controller', 'main.ts', 'package.json', 'remote', 'runtime', 'tsconfig.json',
    ]);
    expect(existsSync(join(server, 'runtime/execution-runtime.ts'))).toBe(true);
    expect(existsSync(join(server, 'remote/client/executor-client.ts'))).toBe(true);
    expect(existsSync(join(server, 'remote/server/executor-rpc-server.ts'))).toBe(true);
  });

  test('prevents runtime, transport, and common from importing controller policy', () => {
    for (const owner of ['common', 'runtime', 'remote']) {
      for (const filename of sources(join(server, owner))) {
        for (const dependency of imports(filename)) {
          expect(dependency, relative(root, filename)).not.toMatch(/^controller\//);
          if (owner === 'common') expect(dependency, relative(root, filename)).not.toMatch(/^(runtime|remote)\//);
          if (owner === 'runtime') expect(dependency, relative(root, filename)).not.toMatch(/^remote\//);
          if (owner === 'remote' && relative(server, filename) !== 'remote/worker.ts') {
            expect(dependency, relative(root, filename)).not.toMatch(/^runtime\//);
          }
        }
      }
    }
  });

  test('uses executor terminology at the public command and runtime-discovery boundaries', () => {
    expect(readFileSync(join(server, 'main.ts'), 'utf8')).toContain("process.argv[2] === 'executor'");
    expect(readFileSync(join(root, 'common/cli-runtime-paths.ts'), 'utf8')).toContain("'controller' | 'executor'");
    expect(readFileSync(join(server, 'remote/worker.ts'), 'utf8')).toContain("process.env.GARCON_RUNTIME = 'executor'");
  });
});
