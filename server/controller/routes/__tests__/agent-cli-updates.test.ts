import { expect, test } from 'bun:test';
import {
  IDLE_AGENT_CLI_UPDATE_RUN,
  parseAgentCliUpdatesResponse,
  parseAgentCliUpdateStatus,
  type AgentCliUpdateStatus,
} from '../../../../common/agent-cli-update.js';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { DomainError } from '../../../common/domain-error.js';
import { createAgentCliUpdateRoutes } from '../agent-cli-updates.js';
import type { AgentCliUpdateService } from '../../cli-updates/cli-update-service.js';

const REMOTE_EXECUTOR = '22222222-2222-4222-8222-222222222222';
const PATH = '/api/v1/agents/cli-updates';

const STATUS: AgentCliUpdateStatus = {
  cliLabel: 'Codex CLI',
  installMethod: 'npm',
  installPath: '/opt/synthetic/lib/node_modules/@openai/codex/bin/codex.js',
  currentVersion: '0.169.0',
  latestVersion: '0.170.0',
  advisory: 'behind-latest',
  updateCommand: 'npm install -g --prefix /opt/synthetic --allow-scripts=@openai/codex @openai/codex@latest',
  canUpdate: true,
  message: null,
  checkedAt: '2026-11-20T00:00:00.000Z',
  run: IDLE_AGENT_CLI_UPDATE_RUN,
};

function routes(overrides: Partial<Pick<AgentCliUpdateService, 'statuses' | 'start'>>) {
  return createAgentCliUpdateRoutes({
    statuses: async () => ({ statuses: {}, failures: {} }),
    start: async () => STATUS,
    ...overrides,
  })[PATH]!;
}

test('reads statuses for the requested executor and refresh mode', async () => {
  const calls: Array<[string, boolean, readonly string[] | undefined]> = [];
  const route = routes({
    statuses: async (executorId, options) => {
      calls.push([executorId, options.refresh, options.agentIds]);
      return { statuses: { codex: STATUS }, failures: { claude: 'claude was not found' } };
    },
  });
  const url = new URL(`http://localhost${PATH}?executorId=${REMOTE_EXECUTOR}&refresh=1`);
  const response = await route.GET!(new Request(url), url);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(parseAgentCliUpdatesResponse(await response.json())).toEqual({
    statuses: { codex: STATUS }, failures: { claude: 'claude was not found' },
  });
  const local = new URL(`http://localhost${PATH}?agent=claude&agent=codex`);
  await route.GET!(new Request(local), local);
  expect(calls).toEqual([[REMOTE_EXECUTOR, true, undefined], ['local', false, ['claude', 'codex']]]);
});

test('starts an update for the agent and executor in the body', async () => {
  const calls: Array<[string, string]> = [];
  const route = routes({ start: async (executorId, agentId) => { calls.push([executorId, agentId]); return STATUS; } });
  const url = new URL(`http://localhost${PATH}`);
  const post = (body: unknown) => route.POST!(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), url);
  const response = await post({ agentId: 'codex', executorId: REMOTE_EXECUTOR });
  expect(response.status).toBe(200);
  expect(parseAgentCliUpdateStatus(await response.json())).toEqual(STATUS);
  expect(calls).toEqual([[REMOTE_EXECUTOR, 'codex']]);

  expect((await post({ executorId: REMOTE_EXECUTOR })).status).toBe(400);
  expect((await post({ agentId: 'codex', executorId: 'not-an-executor' })).status).toBe(400);
  expect(calls).toHaveLength(1);
});

test('maps unsupported updates and unavailable executors to their HTTP status', async () => {
  const unsupported = routes({ start: async () => { throw new AgentIntegrationError('OPERATION_UNSUPPORTED', 'Bundled with Garcon.', false); } });
  const url = new URL(`http://localhost${PATH}`);
  const response = await unsupported.POST!(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'codex' }),
  }), url);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ errorCode: 'OPERATION_UNSUPPORTED', error: 'Bundled with Garcon.' });

  const unavailable = routes({ statuses: async () => { throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is unavailable', 503, true); } });
  const getUrl = new URL(`http://localhost${PATH}?executorId=${REMOTE_EXECUTOR}`);
  expect((await unavailable.GET!(new Request(getUrl), getUrl)).status).toBe(503);
});
