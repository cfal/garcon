import type { RefinePromptRequest } from '../../common/prompt-refinement.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import {
  createRateLimiter,
  type RateLimiter,
  type RequestIpServer,
} from '../lib/rate-limit.js';
import { refinePrompt } from '../prompt-refinement/refine-prompt.js';
import type { SettingsStore } from '../settings/store.js';

const defaultLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20 });

function asRequestIpServer(server: unknown): RequestIpServer | null {
  return server && typeof server === 'object' ? server as RequestIpServer : null;
}

export default function createPromptRefinementRoutes(
  dependencies: {
    settings: Pick<SettingsStore, 'getUiSettings'>;
    agents: AgentRegistryServiceContract;
  },
  options: { limiter?: Pick<RateLimiter, 'check'> } = {},
): RouteMap {
  const limiter = options.limiter ?? defaultLimiter;
  const postWithBody = withJsonBody<RefinePromptRequest>(async (body, request) => {
    try {
      return Response.json(await refinePrompt(body, dependencies, request.signal));
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  });

  const post: RouteHandler = (request, url, server, context) => {
    const limited = limiter.check(request, asRequestIpServer(server));
    if (limited) return limited;
    return postWithBody(request, url, server, context);
  };

  return {
    '/api/v1/prompts/refine': { POST: post },
  };
}
