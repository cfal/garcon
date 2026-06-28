import { promises as fs } from 'fs';
import { getFactoryApiKey } from '../../config.js';
import { getFactoryAuthPaths } from './factory-paths.js';

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

  const authArtifacts = await Promise.all(getFactoryAuthPaths().map((filePath) => hasAuthArtifact(filePath)));
  if (authArtifacts.some(Boolean)) {
    return { authenticated: true, canReauth: false as const, label: '' };
  }

  return { authenticated: false, canReauth: false as const, label: '' };
}
