import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptsDir, '..');
export const webBuildDir = path.join(repoRoot, 'web', 'build');
export const webBuildMarker = path.join(webBuildDir, '.garcon-build-input-hash');
const webBuildMarkerVersion = 1;

export const webBuildInputs = [
  path.join(repoRoot, 'common'),
  path.join(repoRoot, 'web', 'messages'),
  path.join(repoRoot, 'web', 'src'),
  path.join(repoRoot, 'web', 'static'),
  path.join(repoRoot, 'web', 'bun.lock'),
  path.join(repoRoot, 'web', 'codemirror-packages.ts'),
  path.join(repoRoot, 'web', 'package.json'),
  path.join(repoRoot, 'web', 'project.inlang'),
  path.join(repoRoot, 'web', 'svelte.config.js'),
  path.join(repoRoot, 'web', 'tsconfig.json'),
  path.join(repoRoot, 'web', 'vite.config.ts'),
];

async function collectFiles(inputPath, rootPath, inputIndex, files) {
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
    await collectFiles(path.join(inputPath, entry.name), rootPath, inputIndex, files);
  }
}

export async function computeWebBuildHash(inputs = webBuildInputs) {
  const files = [];
  for (const [index, inputPath] of inputs.entries()) {
    await collectFiles(inputPath, inputPath, index, files);
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
  return hash.digest('hex');
}

async function collectBuildAssets(directory, buildDir, markerPath, assets) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectBuildAssets(absolutePath, buildDir, markerPath, assets);
    } else if (entry.isFile() && absolutePath !== markerPath) {
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

export async function isWebBuildCurrent({
  buildDir = webBuildDir,
  markerPath = webBuildMarker,
  inputs = webBuildInputs,
  sourcePath = path.join(repoRoot, 'web', 'src'),
} = {}) {
  const [sourceStat, markerContents] = await Promise.all([
    fs.stat(sourcePath).catch(() => null),
    fs.readFile(markerPath, 'utf8').catch(() => ''),
  ]);
  const marker = parseBuildMarker(markerContents);
  if (!marker || !await hasRecordedBuildAssets(buildDir, marker.assets)) return false;
  // Published packages contain the compiled client but not its source tree.
  if (!sourceStat) return true;
  return marker.hash === await computeWebBuildHash(inputs);
}

export async function recordWebBuild({
  buildDir = webBuildDir,
  hash,
  markerPath = webBuildMarker,
  inputs = webBuildInputs,
} = {}) {
  await fs.mkdir(buildDir, { recursive: true });
  const marker = {
    version: webBuildMarkerVersion,
    hash: hash ?? await computeWebBuildHash(inputs),
    assets: await listBuildAssets(buildDir, markerPath),
  };
  await fs.writeFile(markerPath, `${JSON.stringify(marker)}\n`);
}
