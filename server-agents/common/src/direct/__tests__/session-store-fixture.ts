import crypto from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DirectSessionStore } from '../session-store.ts';

const directories: string[] = [];

export function createTestDirectSessionStore(ownerId = 'direct-test'): DirectSessionStore {
  const root = path.join(os.tmpdir(), `garcon-direct-test-${crypto.randomUUID()}`);
  directories.push(root);
  const rootDirectory = path.join(root, 'agent-data', ownerId);
  return new DirectSessionStore({
    host: {
      agentId: ownerId,
      storage: {
        rootDirectory,
        async directory(namespace) {
          const directory = path.join(rootDirectory, namespace);
          await mkdir(directory, { recursive: true });
          return directory;
        },
        async claimLegacyWorkspaceDirectory() {
          return { moved: 0, skipped: 0 };
        },
      },
    },
  });
}

export async function removeTestDirectSessionStores(): Promise<void> {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
}
