import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseSvelte } from 'svelte/compiler';
import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.svelte',
]);
const PRODUCTION_SKIPPED_DIRECTORIES = new Set([
  '.svelte-kit',
  '__tests__',
  'build',
  'dist',
  'node_modules',
]);
const AUDIT_SKIPPED_DIRECTORIES = new Set(['.svelte-kit', 'build', 'dist', 'node_modules']);
const MODULE_LOADER_METHODS = new Set(['doMock', 'mock', 'unmock']);
const RETIRED_COMMON_SUBPATHS = [
  'agent-settings',
  'chat-filter-query',
  'client-chat-id',
  'start-selection',
  'workspace-layout',
];

function callModuleSpecifier(node) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return null;
  const [argument] = node.arguments;
  if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) return null;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return argument.text;
  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') return argument.text;
  if (ts.isPropertyAccessExpression(node.expression)) {
    if (MODULE_LOADER_METHODS.has(node.expression.name.text)) return argument.text;
    if (
      node.expression.name.text === 'module'
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'mock'
    ) {
      return argument.text;
    }
  }
  return null;
}

function importTypeModuleSpecifier(node) {
  if (!ts.isImportTypeNode(node) || !ts.isLiteralTypeNode(node.argument)) return null;
  return ts.isStringLiteral(node.argument.literal) ? node.argument.literal.text : null;
}

function declarationModuleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier
    && ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
    && node.moduleReference.expression
    && ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  return null;
}

function moduleSpecifier(node) {
  return declarationModuleSpecifier(node)
    ?? importTypeModuleSpecifier(node)
    ?? callModuleSpecifier(node);
}

function extractTypeScriptModuleSpecifiers(source, fileName) {
  const specifiers = [];
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    const specifier = moduleSpecifier(node);
    if (specifier !== null) specifiers.push(specifier);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function svelteStringValue(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type !== 'TemplateLiteral' || node.expressions?.length !== 0) return null;
  const [quasi] = node.quasis ?? [];
  return quasi?.value?.cooked ?? quasi?.value?.raw ?? null;
}

function svelteCallModuleSpecifier(node) {
  if (node.type !== 'CallExpression' || node.arguments?.length === 0) return null;
  const specifier = svelteStringValue(node.arguments[0]);
  if (specifier === null) return null;
  if (node.callee?.type === 'Identifier' && node.callee.name === 'require') return specifier;
  if (node.callee?.type !== 'MemberExpression' || node.callee.computed) return null;
  const method = node.callee.property?.name;
  if (MODULE_LOADER_METHODS.has(method)) return specifier;
  if (
    method === 'module'
    && node.callee.object?.type === 'Identifier'
    && node.callee.object.name === 'mock'
  ) {
    return specifier;
  }
  return null;
}

function svelteModuleSpecifier(node) {
  if (
    node.type === 'ImportDeclaration'
    || node.type === 'ExportNamedDeclaration'
    || node.type === 'ExportAllDeclaration'
    || node.type === 'ImportExpression'
  ) {
    return svelteStringValue(node.source);
  }
  if (node.type === 'TSImportType') return svelteStringValue(node.argument);
  if (node.type === 'TSImportEqualsDeclaration') {
    return svelteStringValue(node.moduleReference?.expression);
  }
  return svelteCallModuleSpecifier(node);
}

function extractSvelteModuleSpecifiers(source) {
  const discovered = [];
  const visited = new WeakSet();
  let order = 0;

  function visit(node) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    const specifier = svelteModuleSpecifier(node);
    if (specifier !== null) {
      discovered.push({ specifier, start: node.start ?? Number.MAX_SAFE_INTEGER, order });
      order += 1;
    }
    for (const child of Object.values(node)) visit(child);
  }

  visit(parseSvelte(source, { modern: true }));
  discovered.sort((left, right) => left.start - right.start || left.order - right.order);
  return discovered.map(({ specifier }) => specifier);
}

export function extractModuleSpecifiers(source, fileName = 'source.ts') {
  return fileName.endsWith('.svelte')
    ? extractSvelteModuleSpecifiers(source)
    : extractTypeScriptModuleSpecifiers(source, fileName);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizedSpecifier(specifier) {
  return specifier.split(/[?#]/u, 1)[0];
}

function modulePathStem(fileName) {
  return fileName.replace(/\.(?:[cm]?[jt]sx?|svelte)$/u, '');
}

async function sourceFiles(root, skippedDirectories) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) await visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const fileName = path.join(directory, entry.name);
      if (SOURCE_EXTENSIONS.has(path.extname(fileName))) files.push(fileName);
    }
  }
  await visit(root);
  return files;
}

async function existingSourceFiles(root, skippedDirectories) {
  try {
    return await sourceFiles(root, skippedDirectories);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function resolveCommonTarget({ importer, specifier, commonRoot, packageExports }) {
  const normalized = normalizedSpecifier(specifier);
  if (normalized.startsWith('.')) {
    return path.resolve(path.dirname(importer), normalized);
  }
  if (normalized.startsWith('$shared/')) {
    return path.resolve(commonRoot, normalized.slice('$shared/'.length));
  }
  if (!normalized.startsWith('@garcon/common/')) return null;
  const subpath = normalized.slice('@garcon/common/'.length);
  const exportTarget = packageExports[`./${subpath}`];
  return typeof exportTarget === 'string'
    ? path.resolve(commonRoot, exportTarget)
    : path.resolve(commonRoot, subpath);
}

function targetsApplicationImplementation(importer, specifier, repositoryRoot) {
  const normalized = normalizedSpecifier(specifier);
  if (normalized.startsWith('$lib/')) return true;
  if (
    normalized === '@garcon/cli'
    || normalized.startsWith('@garcon/cli/')
    || normalized === '@garcon/server'
    || normalized.startsWith('@garcon/server/')
    || normalized === '@garcon/web'
    || normalized.startsWith('@garcon/web/')
    || normalized.startsWith('@garcon/server-agent-')
  ) {
    return true;
  }
  if (!normalized.startsWith('.')) return false;
  const target = path.resolve(path.dirname(importer), normalized);
  return [
    path.join(repositoryRoot, 'cli'),
    path.join(repositoryRoot, 'server'),
    path.join(repositoryRoot, 'server-agents'),
    path.join(repositoryRoot, 'web'),
  ].some((applicationRoot) => isWithin(applicationRoot, target));
}

async function productionFiles(repositoryRoot, errors) {
  const roots = [
    path.join(repositoryRoot, 'common'),
    path.join(repositoryRoot, 'server'),
    path.join(repositoryRoot, 'server-agents'),
  ];
  const files = [];
  for (const root of roots) {
    const discoveredFiles = await existingSourceFiles(root, PRODUCTION_SKIPPED_DIRECTORIES);
    const label = path.relative(repositoryRoot, root);
    if (discoveredFiles === null) {
      errors.push(`Common architecture scan root is missing: ${label}`);
      continue;
    }
    const rootFiles = discoveredFiles.filter(
      (fileName) => !/\.(?:spec|test)\.[^.]+$/u.test(fileName),
    );
    if (rootFiles.length === 0) {
      errors.push(`Common architecture scan root has no production files: ${label}`);
      continue;
    }
    files.push(...rootFiles);
  }
  return files;
}

async function retiredCommonImportErrors(repositoryRoot) {
  const commonRoot = path.join(repositoryRoot, 'common');
  const retiredPackageSpecifiers = new Set(
    RETIRED_COMMON_SUBPATHS.map((subpath) => `@garcon/common/${subpath}`),
  );
  const retiredSharedSpecifiers = new Set(
    RETIRED_COMMON_SUBPATHS.map((subpath) => `$shared/${subpath}`),
  );
  const retiredFileStems = new Set(
    RETIRED_COMMON_SUBPATHS.map((subpath) => modulePathStem(path.join(commonRoot, subpath))),
  );
  const roots = [
    'common',
    'cli',
    'web',
    'server',
    'server-agents',
    'scripts',
    'integration-tests',
  ].map((directory) => path.join(repositoryRoot, directory));
  const errors = [];

  for (const root of roots) {
    const files = await existingSourceFiles(root, AUDIT_SKIPPED_DIRECTORIES);
    if (files === null) continue;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const specifier of extractModuleSpecifiers(source, file)) {
        const normalized = normalizedSpecifier(specifier);
        const retiredAlias = retiredPackageSpecifiers.has(normalized)
          || retiredSharedSpecifiers.has(normalized);
        const retiredRelative = normalized.startsWith('.')
          && retiredFileStems.has(modulePathStem(path.resolve(path.dirname(file), normalized)));
        if (retiredAlias || retiredRelative) {
          errors.push(`${path.relative(repositoryRoot, file)} uses retired import ${specifier}`);
        }
      }
    }
  }
  return errors;
}

export async function commonArchitectureErrors(repositoryRoot) {
  const commonRoot = path.join(repositoryRoot, 'common');
  const clientRoot = path.join(commonRoot, 'client');
  const serverRoot = path.join(repositoryRoot, 'server');
  const agentRoot = path.join(repositoryRoot, 'server-agents');
  const errors = [];
  let packageExports = {};
  try {
    const packageJson = JSON.parse(await readFile(path.join(commonRoot, 'package.json'), 'utf8'));
    packageExports = packageJson.exports ?? {};
  } catch (error) {
    errors.push(`Cannot read common/package.json: ${error instanceof Error ? error.message : error}`);
  }

  const files = await productionFiles(repositoryRoot, errors);
  for (const file of files) {
    const relativeFile = path.relative(repositoryRoot, file);
    const inClient = isWithin(clientRoot, file);
    const inRootCommon = isWithin(commonRoot, file) && !inClient;
    const inServer = isWithin(serverRoot, file) || isWithin(agentRoot, file);
    const source = await readFile(file, 'utf8');
    for (const specifier of extractModuleSpecifiers(source, file)) {
      const commonTarget = resolveCommonTarget({
        importer: file,
        specifier,
        commonRoot,
        packageExports,
      });
      if ((inRootCommon || inServer) && commonTarget && isWithin(clientRoot, commonTarget)) {
        errors.push(`${relativeFile} cannot import ${specifier}`);
      }
      if (inClient && (commonTarget === null || !isWithin(commonRoot, commonTarget))) {
        errors.push(`${relativeFile} cannot import ${specifier}`);
      }
      if (inRootCommon && targetsApplicationImplementation(file, specifier, repositoryRoot)) {
        errors.push(`${relativeFile} cannot import ${specifier}`);
      }
    }
  }
  errors.push(...await retiredCommonImportErrors(repositoryRoot));
  return [...new Set(errors)].sort();
}
