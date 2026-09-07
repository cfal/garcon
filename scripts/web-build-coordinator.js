import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertWebBuildInputsUnchanged,
  computeWebBuildHash,
  invalidateWebBuild,
  isWebBuildCurrent,
  isWebBuildRecordedForHash,
  productionWebBuildEnvironment,
  recordWebBuild,
  repoRoot,
  webBuildMarker,
} from './web-build-cache.js';

const webRoot = path.join(repoRoot, 'web');
export const webBuildLockPath = path.join(webRoot, '.garcon-web-build.lock');
const webBuildSourcePath = path.join(webRoot, 'src');

export class WebBuildProcessError extends Error {
  constructor(exitCode) {
    super(`Web build failed with exit code ${exitCode}.`);
    this.name = 'WebBuildProcessError';
    this.exitCode = exitCode;
  }
}

async function existingLockIsDirectory(lockPath) {
  const stat = await fs.stat(lockPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return false;
  if (stat.isDirectory()) return true;
  throw new Error(
    `Web build lock path is not a directory: ${lockPath}. `
      + 'Stop builders on the host and VM, remove the obsolete lock file, and retry.',
  );
}

// Leaves crashed ownership in place because remote process liveness cannot be proven safely.
export async function acquireWebBuildLock({
  lockPath = webBuildLockPath,
  onContention = () => console.log(
    'Another web build is running; waiting for it to finish. '
      + 'If the lock was abandoned, stop builders on the host and VM before removing it.',
  ),
  retries = Infinity,
  retryDelay = 250,
} = {}) {
  let attempts = 0;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!await existingLockIsDirectory(lockPath)) continue;
      if (attempts >= retries) throw error;
      if (attempts === 0) await onContention();
      attempts += 1;
      await Bun.sleep(retryDelay);
    }
  }

  const owner = {
    version: 1,
    token: randomUUID(),
    hostname: os.hostname(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  try {
    await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`, {
      flag: 'wx',
    });
  } catch (error) {
    await fs.rm(lockPath, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await fs.rm(lockPath, { recursive: true, force: true });
  };
}

async function isSourceFreeBuildCurrent(cacheOptions) {
  const sourcePath = cacheOptions.sourcePath ?? webBuildSourcePath;
  try {
    await fs.stat(sourcePath);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return isWebBuildCurrent(cacheOptions);
  }
}

function replaceProcessEnvironment(environment) {
  for (const key of Object.keys(process.env)) {
    if (environment[key] === undefined) delete process.env[key];
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// Runs Vite in the lock owner so no surviving child can mutate web/build after release.
async function compileWeb(environment) {
  const previousEnvironment = { ...process.env };
  const previousWorkingDirectory = process.cwd();
  try {
    replaceProcessEnvironment(environment);
    process.chdir(webRoot);
    const requireFromWeb = createRequire(path.join(webRoot, 'package.json'));
    const viteEntry = requireFromWeb.resolve('vite');
    const { createBuilder } = await import(pathToFileURL(viteEntry).href);
    const builder = await createBuilder({ root: webRoot }, null);
    await builder.buildApp();
    await builder.runDevTools();
    return 0;
  } finally {
    process.chdir(previousWorkingDirectory);
    replaceProcessEnvironment(previousEnvironment);
  }
}

export async function ensureWebBuild({
  cacheOptions = {},
  compile = compileWeb,
  lockOptions,
} = {}) {
  const environment = cacheOptions.environment ?? productionWebBuildEnvironment();
  const currentOptions = { ...cacheOptions, environment };
  if (await isSourceFreeBuildCurrent(currentOptions)) return 'current';

  const release = await acquireWebBuildLock(lockOptions);
  try {
    const inputHash = await computeWebBuildHash(cacheOptions.inputs, environment);
    if (await isWebBuildRecordedForHash(inputHash, cacheOptions)) return 'current';

    await invalidateWebBuild({ markerPath: cacheOptions.markerPath ?? webBuildMarker });
    const exitCode = await compile(environment);
    if (exitCode !== 0) throw new WebBuildProcessError(exitCode);

    const completedInputHash = await computeWebBuildHash(cacheOptions.inputs, environment);
    assertWebBuildInputsUnchanged(inputHash, completedInputHash);
    await recordWebBuild({ ...cacheOptions, hash: inputHash, environment });
    return 'built';
  } finally {
    await release();
  }
}
