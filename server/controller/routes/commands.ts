// Exposes the slash commands available for a project's agent, used by the
// chat composer's "/" autocomplete. Discovery is delegated to the agent
// runtime via the registry; agents without a command catalog return [].

import { resolveProjectPathFromUrl } from './project-path-resolver.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { IChatRegistry } from '../chats/store.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { SlashCommandsResponse } from '../../../common/slash-commands.js';
import type { ProjectInspector } from '../../../common/project-resolution.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';

interface CommandsRouteDeps {
  registry: IChatRegistry;
  agents: AgentRegistryServiceContract;
  inspectProject: ProjectInspector;
}

export default function createCommandsRoutes({ registry, agents, inspectProject }: CommandsRouteDeps): RouteMap {
  async function getCommands(request: Request, url: URL): Promise<Response> {
    try {
      const resolved = await resolveProjectPathFromUrl(registry, url, inspectProject, { signal: request.signal });
      if (resolved.error) return resolved.error;
      request.signal.throwIfAborted();

      const agent = url.searchParams.get('agent')?.trim();
      if (!agent) return Response.json({ error: 'agent is required' }, { status: 400 });
      const commands = await agents.getSlashCommands(agent, resolved.projectPath, resolved.executorId);

      return Response.json({ commands } satisfies SlashCommandsResponse);
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      return jsonErrorFromUnknown(error);
    }
  }

  return {
    '/api/v1/commands': { GET: getCommands },
  };
}
