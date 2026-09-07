import { Database } from 'bun:sqlite';
import { createRequire } from 'node:module';
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

export class WebBuildProcessError extends Error {
  constructor(exitCode) {
    super(`Web build failed with exit code ${exitCode}.`);
    this.name = 'WebBuildProcessError';
    this.exitCode = exitCode;
  }
}

// Keeps exclusion tied to the writer process, including across pauses and crashes.
export async function acquireWebBuildLock({
  lockPath = webBuildLockPath,
  onContention = () => console.log('Another web build is running; waiting for it to finish.'),
  retries = Infinity,
  retryDelay = 250,
} = {}) {
  const database = new Database(lockPath, { create: true });
  database.run('PRAGMA busy_timeout = 0');
  let attempts = 0;
  try {
    while (true) {
      try {
        database.run('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if (error?.code !== 'SQLITE_BUSY' || attempts >= retries) throw error;
        if (attempts === 0) await onContention();
        attempts += 1;
        await Bun.sleep(retryDelay);
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      database.run('COMMIT');
    } finally {
      database.close();
    }
  };
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
  if (await isWebBuildCurrent(currentOptions)) return 'current';

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
