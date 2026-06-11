import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getFactoryApiKey } from '../../config.js';

const FACTORY_HOME = path.join(os.homedir(), '.factory');
const FACTORY_AUTH_PATHS = [
  path.join(FACTORY_HOME, 'auth.json'),
  path.join(FACTORY_HOME, 'auth.v2.file'),
  path.join(FACTORY_HOME, 'auth.v2.key'),
];

async function hasAuthArtifact(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

export async function getFactoryAuthStatus() {
  if (getFactoryApiKey()) {
    return { authenticated: true, canReauth: false as const, label: '' };
  }

  const authArtifacts = await Promise.all(FACTORY_AUTH_PATHS.map((filePath) => hasAuthArtifact(filePath)));
  if (authArtifacts.some(Boolean)) {
    return { authenticated: true, canReauth: false as const, label: '' };
  }

  return { authenticated: false, canReauth: false as const, label: '' };
}
