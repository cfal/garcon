import { cliWireV1 } from './cli-protocol.js';

// Explicit forwarding opt-in; future declarations do not extend this released adapter.
export const CLI_WIRES_V1 = Object.freeze(([
  'GET /api/v1/scheduled-prompts', 'POST /api/v1/scheduled-prompts', 'PUT /api/v1/scheduled-prompts',
  'DELETE /api/v1/scheduled-prompts', 'PUT /api/v1/scheduled-prompts/enabled',
  'GET /api/v1/executors', 'POST /api/v1/executors', 'PATCH /api/v1/executors/:executorId',
  'DELETE /api/v1/executors/:executorId', 'GET /api/v1/executors/:executorId/connection',
  'GET /api/v1/api-provider-assignments', 'PUT /api/v1/api-provider-assignments', 'DELETE /api/v1/api-provider-assignments',
  'GET /api/v1/models', 'GET /api/v1/app/settings', 'GET /api/v1/preambles', 'GET /api/v1/chats',
  'GET /api/v1/chats/messages', 'GET /api/v1/chats/snapshot', 'GET /api/v1/chats/turn-receipt',
  'GET /api/v1/chats/export', 'GET /api/v1/chats/handoff-artifact', 'POST /api/v1/chats/lookup-native-session',
  'POST /api/v1/chats/search', 'GET /api/v1/chats/search/status', 'POST /api/v1/chats/search/rebuild',
  'PUT /api/v1/app/settings', 'POST /api/v1/chats/start', 'POST /api/v1/chats/run', 'POST /api/v1/chats/fork',
  'POST /api/v1/chats/fork-run', 'POST /api/v1/chats/steer', 'POST /api/v1/chats/stop',
  'POST /api/v1/chats/permissions/decision', 'GET /api/v1/chats/rows', 'POST /api/v1/chats/rows',
  'PUT /api/v1/app/session-name', 'PUT /api/v1/chats/pin', 'PUT /api/v1/chats/archive',
  'GET /api/v1/chats/tags', 'PUT /api/v1/chats/tags', 'GET /api/v1/tickets/bootstrap',
  'GET /api/v1/tickets', 'GET /api/v1/tickets/detail', 'GET /api/v1/tickets/history',
  'POST /api/v1/tickets/project-default', 'POST /api/v1/tickets/mutate',
] as const).map(cliWireV1));
