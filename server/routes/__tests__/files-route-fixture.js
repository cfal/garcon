import { getHomeDirectoryPath, getProjectBasePath } from '../../config.js';
import { LocalWorkspaceFileService } from '../../execution-node/local-workspace-files.js';
import { KeyedPromiseLock } from '../../lib/keyed-lock.js';
import createFilesRoutes from '../files.js';

export function createLocalFilesRoutes(registry, overrides = {}) {
  return createFilesRoutes(registry, new LocalWorkspaceFileService({
    projectBasePath: getProjectBasePath(), homeDirectoryPath: getHomeDirectoryPath(),
    saveLocks: new KeyedPromiseLock(), ...overrides,
  }));
}
