#!/usr/bin/env bun

import { computeWebBuildHash, recordWebBuild, repoRoot } from './web-build-cache.js';

const inputHash = await computeWebBuildHash();
const build = Bun.spawn(['bun', 'run', '--cwd', 'web', 'build'], {
  cwd: repoRoot,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
const exitCode = await build.exited;
if (exitCode !== 0) process.exit(exitCode);
await recordWebBuild({ hash: inputHash });
