#!/usr/bin/env bun

import { ensureWebBuild, WebBuildProcessError } from './web-build-coordinator.js';

export function assertWebBuildArguments(args) {
  if (args.length === 0) return;
  throw new Error(
    `Web builds use the production coordinator and do not accept Vite CLI arguments: ${args.join(' ')}`,
  );
}

async function main(args = process.argv.slice(2)) {
  assertWebBuildArguments(args);
  const result = await ensureWebBuild();
  if (result === 'current') console.log('Web build is current; skipping rebuild.');
}

if (import.meta.main) {
  main().catch((error) => {
    if (error instanceof WebBuildProcessError) {
      process.exit(error.exitCode);
    }
    console.error(error);
    process.exit(1);
  });
}
