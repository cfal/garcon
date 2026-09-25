import type { ProjectInspector } from '../../../common/project-resolution.js';
import { inspectProjectDirectory as inspectDirectory } from '../../runtime/projects/project-directory-service.js';
import { assertRealWithinProjectBase } from '../lib/path-boundary.js';

export const inspectProjectDirectory: ProjectInspector = (projectPath) => inspectDirectory(projectPath, {
  resolvePath: assertRealWithinProjectBase,
});
