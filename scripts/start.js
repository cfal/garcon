#!/usr/bin/env bun

import { isWebBuildCurrent } from './web-build-cache.js';

if (await isWebBuildCurrent()) {
  console.log('Web build is current; skipping rebuild.');
} else {
  await import('./build-web.js');
}

await import('../server/main.js');
