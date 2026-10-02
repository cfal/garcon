import path from 'node:path';
import type { ProjectInspector } from '../../../common/project-resolution.js';
import { inspectProjectDirectory as inspectDirectory } from '../../runtime/projects/project-directory-service.js';
import { assertRealWithinBase } from '../../common/path-boundary.js';
import { getProjectBasePath } from '../config.js';

export const inspectProjectDirectory: ProjectInspector = (projectPath) => inspectDirectory(projectPath, {
  resolvePath: (targetPath) => assertRealWithinBase(path.resolve(getProjectBasePath()), targetPath),
});
