import createFilesRoutes from '../files.js';
import { getHomeDirectoryPath, getProjectBasePath } from '../../config.js';
import { LocalExecutionFilesService, type FilesServiceOptions } from '../../files/service.js';
import { inspectProjectDirectory } from '../../projects/project-directory-service.js';

export function createLocalFilesRoutes(
  registry: Parameters<typeof createFilesRoutes>[0],
  options: Pick<FilesServiceOptions, 'resolveSaveTarget' | 'readDirectory'> = {},
) {
  const files = new LocalExecutionFilesService({
    nodeId: 'local', projectBasePath: getProjectBasePath(), homeDirectory: getHomeDirectoryPath(), ...options,
  });
  return createFilesRoutes(registry, { files: async () => files, inspectProject: inspectProjectDirectory });
}
