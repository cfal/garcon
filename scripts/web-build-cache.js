import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptsDir, '..');
export const webBuildDir = path.join(repoRoot, 'web', 'build');
export const webBuildMarker = path.join(webBuildDir, '.garcon-build-input-hash');
const webBuildMarkerVersion = 2;
const webBuildEnvironmentPrefixes = ['PUBLIC_', 'VITE_'];
// Excludes Paraglide output that Vite rewrites from the canonical messages and settings inputs.
const webBuildIgnoredInputPaths = new Set([
  path.join(repoRoot, 'web', 'src', 'lib', 'paraglide'),
]);

export const webBuildInputs = [
  path.join(repoRoot, 'common'),
  path.join(repoRoot, 'web', '.env'),
  path.join(repoRoot, 'web', '.env.local'),
  path.join(repoRoot, 'web', '.env.production'),
  path.join(repoRoot, 'web', '.env.production.local'),
  path.join(repoRoot, 'web', 'messages'),
  path.join(repoRoot, 'web', 'src'),
  path.join(repoRoot, 'web', 'static'),
  path.join(repoRoot, 'bun.lock'),
  path.join(repoRoot, 'patches'),
  path.join(repoRoot, 'web', 'codemirror-packages.ts'),
  path.join(repoRoot, 'web', 'package.json'),
  path.join(repoRoot, 'web', 'project.inlang', 'settings.json'),
  path.join(repoRoot, 'web', 'svelte.config.js'),
  path.join(repoRoot, 'web', 'tsconfig.json'),
  path.join(repoRoot, 'web', 'vite.config.ts'),
];

export function productionWebBuildEnvironment(environment = process.env) {
  return { ...environment, NODE_ENV: 'production' };
}

async function collectFiles(inputPath, rootPath, inputIndex, files, ignoredPaths) {
  if (ignoredPaths.has(inputPath)) return;
  const stat = await fs.stat(inputPath).catch(() => null);
  if (!stat) return;
  if (stat.isFile()) {
    files.push({
      absolutePath: inputPath,
      inputIndex,
      relativePath: path.relative(rootPath, inputPath),
    });
    return;
  }
  if (!stat.isDirectory()) return;

  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.svelte-kit' || entry.name === 'build') {
      continue;
    }
    await collectFiles(
      path.join(inputPath, entry.name),
      rootPath,
      inputIndex,
      files,
      ignoredPaths,
    );
  }
}

function buildEnvironmentEntries(environment) {
  const entries = [['NODE_ENV', environment.NODE_ENV ?? 'production']];
  entries.push(...Object.entries(environment).filter(([key, value]) => {
    return value !== undefined
      && webBuildEnvironmentPrefixes.some((prefix) => key.startsWith(prefix));
  }));
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

export async function computeWebBuildHash(
  inputs = webBuildInputs,
  environment = process.env,
  ignoredPaths = webBuildIgnoredInputPaths,
) {
  const files = [];
  for (const [index, inputPath] of inputs.entries()) {
    await collectFiles(inputPath, inputPath, index, files, ignoredPaths);
  }
  files.sort((left, right) => {
    return left.inputIndex - right.inputIndex
      || left.relativePath.localeCompare(right.relativePath);
  });

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file.inputIndex}:${file.relativePath}\0`);
    hash.update(await fs.readFile(file.absolutePath));
    hash.update('\0');
  }
  // Captures variables that Vite and SvelteKit inline into client bundles.
  for (const [key, value] of buildEnvironmentEntries(environment)) {
    hash.update(`environment:${key}\0${value}\0`);
  }
  return hash.digest('hex');
}

async function collectBuildAssets(directory, buildDir, markerPath, assets) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectBuildAssets(absolutePath, buildDir, markerPath, assets);
    } else if (
      entry.isFile()
      && absolutePath !== markerPath
      && !absolutePath.startsWith(`${markerPath}.`)
    ) {
      const stat = await fs.stat(absolutePath);
      assets.push({
        path: path.relative(buildDir, absolutePath).split(path.sep).join('/'),
        size: stat.size,
      });
    }
  }
}

async function listBuildAssets(buildDir, markerPath) {
  const assets = [];
  await collectBuildAssets(buildDir, buildDir, markerPath, assets);
  return assets.sort((left, right) => left.path.localeCompare(right.path));
}

function isSafeAssetPath(assetPath) {
  return typeof assetPath === 'string'
    && !path.posix.isAbsolute(assetPath)
    && assetPath.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function parseBuildMarker(contents) {
  try {
    const marker = JSON.parse(contents);
    if (
      marker?.version !== webBuildMarkerVersion
      || typeof marker.hash !== 'string'
      || !Array.isArray(marker.assets)
      || marker.assets.length === 0
      || marker.assets.some((asset) => {
        return !asset
          || !isSafeAssetPath(asset.path)
          || !Number.isSafeInteger(asset.size)
          || asset.size < 0;
      })
    ) {
      return null;
    }
    return marker;
  } catch {
    return null;
  }
}

async function hasRecordedBuildAssets(buildDir, assets) {
  const stats = await Promise.all(
    assets.map((asset) => fs.stat(
      path.join(buildDir, ...asset.path.split('/')),
    ).catch(() => null)),
  );
  return stats.every((stat, index) => stat?.isFile() && stat.size === assets[index].size);
}

async function readRecordedWebBuild(buildDir, markerPath) {
  const markerContents = await fs.readFile(markerPath, 'utf8').catch(() => '');
  const marker = parseBuildMarker(markerContents);
  if (!marker || !await hasRecordedBuildAssets(buildDir, marker.assets)) return null;
  return marker;
}

export async function isWebBuildRecordedForHash(hash, {
  buildDir = webBuildDir,
  markerPath = webBuildMarker,
} = {}) {
  const marker = await readRecordedWebBuild(buildDir, markerPath);
  return marker?.hash === hash;
}

export async function isWebBuildCurrent({
  buildDir = webBuildDir,
  environment = productionWebBuildEnvironment(),
  markerPath = webBuildMarker,
  inputs = webBuildInputs,
  sourcePath = path.join(repoRoot, 'web', 'src'),
} = {}) {
  const [sourceStat, marker] = await Promise.all([
    fs.stat(sourcePath).catch(() => null),
    readRecordedWebBuild(buildDir, markerPath),
  ]);
  if (!marker) return false;
  // Published packages contain the compiled client but not its source tree.
  if (!sourceStat) return true;
  return marker.hash === await computeWebBuildHash(inputs, environment);
}

export async function recordWebBuild({
  buildDir = webBuildDir,
  environment = productionWebBuildEnvironment(),
  hash,
  markerPath = webBuildMarker,
  inputs = webBuildInputs,
} = {}) {
  await fs.mkdir(buildDir, { recursive: true });
  const marker = {
    version: webBuildMarkerVersion,
    hash: hash ?? await computeWebBuildHash(inputs, environment),
    assets: await listBuildAssets(buildDir, markerPath),
  };
  const temporaryMarkerPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryMarkerPath, `${JSON.stringify(marker)}\n`, { flag: 'wx' });
    await fs.rename(temporaryMarkerPath, markerPath);
  } finally {
    await fs.rm(temporaryMarkerPath, { force: true });
  }
}

export async function invalidateWebBuild({ markerPath = webBuildMarker } = {}) {
  await fs.rm(markerPath, { force: true });
}

export async function assertWebBuildCurrent(options = {}) {
  if (await isWebBuildCurrent(options)) return;
  throw new Error(
    'web/build is missing or stale for the current client sources, dependencies, patches, or build environment. ' +
      'Run `bun run build` from the repository root before browser tests. ' +
      'The root and web workspace build commands both use the Garcon build coordinator.',
  );
}

export function assertWebBuildInputsUnchanged(expectedHash, actualHash) {
  if (expectedHash === actualHash) return;
  throw new Error(
    'Web build inputs changed while the client was compiling. Run `bun run build` again before ' +
      'starting the server or browser tests.',
  );
}
