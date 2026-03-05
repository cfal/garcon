// /api/opencode/* route handlers. Provides auth status via the OpenCode SDK.
// Model listing is handled by the unified models.js.
import { getOpenCodeAuthStatus } from '../providers/opencode-auth.js';

export default function createOpenCodeRoutes(opencode) {
  async function getOpenCodeAuthStatusRoute() {
    const status = await getOpenCodeAuthStatus(opencode);
    return Response.json(status);
  }

  return {
    '/api/v1/opencode/auth/status': { GET: getOpenCodeAuthStatusRoute },
  };
}
