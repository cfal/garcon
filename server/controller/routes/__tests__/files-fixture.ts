import createFilesRoutes from '../files.js';
import { getHomeDirectoryPath, getProjectBasePath } from '../../config.js';
import { FilesService, type FilesServiceOptions } from '../../../runtime/files/service.js';
import { inspectProjectDirectory } from '../../__tests__/project-inspector.js';

export function createLocalFilesRoutes(
  registry: Parameters<typeof createFilesRoutes>[0],
  options: Pick<FilesServiceOptions, 'resolveSaveTarget' | 'readDirectory'> = {},
) {
  const files = new FilesService({
    executorId: 'local', projectBasePath: getProjectBasePath(), homeDirectory: getHomeDirectoryPath(), ...options,
  });
  return createFilesRoutes(registry, { files: async () => files, inspectProject: inspectProjectDirectory });
}
