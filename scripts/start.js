#!/usr/bin/env bun

import { productionWebBuildEnvironment, repoRoot } from './web-build-cache.js';

// Keeps Vite's process-wide configuration out of the long-lived server process.
const build = Bun.spawn(['bun', 'scripts/build-web.js'], {
  cwd: repoRoot,
  env: productionWebBuildEnvironment(),
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
const exitCode = await build.exited;
if (exitCode !== 0) process.exit(exitCode);

await import('../server/main.js');
