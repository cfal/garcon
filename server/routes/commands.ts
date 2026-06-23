// Exposes the slash commands available for a project's agent, used by the
// chat composer's "/" autocomplete. Discovery is delegated to the agent
// runtime via the registry; agents without a command catalog return [].

import { resolveProjectPathFromUrl } from './project-path-resolver.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { IChatRegistry } from '../chats/store.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { errorMessage } from './route-helpers.js';
import type { SlashCommandsResponse } from '../../common/slash-commands.js';

interface CommandsRouteDeps {
  registry: IChatRegistry;
  agents: AgentRegistryServiceContract;
}

export default function createCommandsRoutes({ registry, agents }: CommandsRouteDeps): RouteMap {
  async function getCommands(_request: Request, url: URL): Promise<Response> {
    try {
      const resolved = await resolveProjectPathFromUrl(registry, url);
      if (resolved.error) return resolved.error;

      const agent = url.searchParams.get('agent') ?? 'claude';
      const commands = await agents.getSlashCommands(agent, resolved.projectPath);

      return Response.json({ commands } satisfies SlashCommandsResponse);
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  return {
    '/api/v1/commands': { GET: getCommands },
  };
}
