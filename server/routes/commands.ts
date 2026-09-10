// Exposes the slash commands available for a project's agent, used by the
// chat composer's "/" autocomplete. Discovery is delegated to the agent
// runtime via the registry; agents without a command catalog return [].

import { projectUnavailableResponse } from './project-path-resolver.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { IChatRegistry } from '../chats/store.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { ProjectUnavailableError } from '../lib/domain-error.js';
import { jsonErrorFromUnknown } from '../lib/http-error.js';
import type { SlashCommandsResponse } from '../../common/slash-commands.js';

interface CommandsRouteDeps {
  registry: Pick<IChatRegistry, 'getChat'>;
  agents: Pick<AgentRegistryServiceContract, 'getChatSlashCommands' | 'getDefaultSlashCommands'>;
}

export default function createCommandsRoutes({ registry, agents }: CommandsRouteDeps): RouteMap {
  async function getCommands(request: Request, url: URL): Promise<Response> {
    try {
      const agent = url.searchParams.get('agent')?.trim();
      if (!agent) return Response.json({ error: 'agent is required' }, { status: 400 });
      const chatId = url.searchParams.get('chatId');
      if (chatId) {
        const chat = registry.getChat(chatId);
        if (!chat?.projectPath) {
          return Response.json({ error: 'Chat not found or missing projectPath' }, { status: 404 });
        }
        const commands = await agents.getChatSlashCommands(chat, agent, request.signal);
        return Response.json({ commands } satisfies SlashCommandsResponse);
      }
      const projectPath = url.searchParams.get('projectPath');
      if (!projectPath) {
        return Response.json({ error: 'chatId or projectPath is required' }, { status: 400 });
      }
      const commands = await agents.getDefaultSlashCommands(agent, projectPath, request.signal);

      return Response.json({ commands } satisfies SlashCommandsResponse);
    } catch (error) {
      if (error instanceof ProjectUnavailableError) return projectUnavailableResponse(error.projectPath, error.reason);
      return jsonErrorFromUnknown(error);
    }
  }

  return {
    '/api/v1/commands': { GET: getCommands },
  };
}
