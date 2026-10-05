// Test preload that makes this process behave like a system that cannot name
// open descriptors by path (macOS, Windows, Linux without procfs), so the
// suite's unsupported configuration is exercised on Linux as well.
import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('../../server/runtime/files/directory-creation.ts', import.meta.url));
const actual = await import(modulePath);
mock.module(modulePath, () => ({ ...actual, descriptorPathsDirectory: () => null }));
