import type { ProjectInspector } from '../../../common/project-resolution.js';
import { PreambleDomainError } from './errors.js';

export class PreambleProjectPathService {
  constructor(private readonly inspect: ProjectInspector) {}

  async resolve(projectPath: string, executorId?: string | null): Promise<string> {
    const resolution = await this.inspect(projectPath.trim(), executorId);
    if (resolution.kind === 'available') return resolution.effectiveProjectKey;
    switch (resolution.reason) {
      case 'not-found':
        throw new PreambleDomainError('PREAMBLE_PROJECT_PATH_NOT_FOUND', `Project path not found: ${projectPath}`, 404);
      case 'outside-base':
        throw new PreambleDomainError('PREAMBLE_PROJECT_PATH_OUTSIDE_BASE', 'Project path is outside the allowed base directory', 403);
      case 'not-a-directory':
        throw new PreambleDomainError('PREAMBLE_PROJECT_PATH_NOT_DIRECTORY', `Project path is not a directory: ${projectPath}`, 400);
      case 'permission-denied':
        throw new PreambleDomainError('PREAMBLE_PROJECT_PATH_INACCESSIBLE', `Project path is not accessible: ${projectPath}`, 403);
    }
  }
}
