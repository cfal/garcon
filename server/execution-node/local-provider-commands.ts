import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { ProjectResolution } from '../../common/project-resolution.js';
import type { SlashCommand } from '../../common/slash-commands.js';
import type { ProviderCommandsRequest, ProviderCommandsService } from '../execution-nodes/provider-commands.js';
import { ProjectUnavailableError } from '../lib/domain-error.js';
import { inspectProjectDirectory } from '../projects/project-directory-service.js';

export class LocalProviderCommandsService implements ProviderCommandsService {
  constructor(
    private readonly integration: Pick<AgentIntegration, 'commands'>,
    private readonly inspectProject: (projectPath: string) => Promise<ProjectResolution> = inspectProjectDirectory,
  ) {}

  async discover(request: ProviderCommandsRequest, signal: AbortSignal): Promise<readonly SlashCommand[]> {
    signal.throwIfAborted();
    const projectPath = request.projectPath;
    const project = await this.inspectProject(projectPath);
    signal.throwIfAborted();
    if (project.kind === 'unavailable') throw new ProjectUnavailableError(projectPath, project.reason);
    const commands = await this.integration.commands?.discover(project.effectiveProjectKey, signal) ?? [];
    signal.throwIfAborted();
    return structuredClone(commands);
  }
}
