#!/usr/bin/env bun

import {
  assertWebBuildInputsUnchanged,
  computeWebBuildHash,
  productionWebBuildEnvironment,
  recordWebBuild,
  repoRoot,
} from './web-build-cache.js';

const environment = productionWebBuildEnvironment();
const inputHash = await computeWebBuildHash(undefined, environment);
const build = Bun.spawn(['bun', 'run', '--cwd', 'web', 'build'], {
  cwd: repoRoot,
  env: environment,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
const exitCode = await build.exited;
if (exitCode !== 0) process.exit(exitCode);
const completedInputHash = await computeWebBuildHash(undefined, environment);
assertWebBuildInputsUnchanged(inputHash, completedInputHash);
await recordWebBuild({ hash: inputHash, environment });
