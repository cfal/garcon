import { expect, test } from 'bun:test';
import {
  AgentCallError,
  AgentIntegrationError,
  type AgentCliUpdates,
  type AgentCliUpdateStatusRequest,
} from '@garcon/server-agent-interface';
import { IDLE_AGENT_CLI_UPDATE_RUN, type AgentCliUpdateStatus } from '../../../../common/agent-cli-update.js';
import { isDomainError } from '../../../common/domain-error.js';
import { AgentCliUpdateService, type CliUpdateExecutors } from '../cli-update-service.js';

const STATUS: AgentCliUpdateStatus = {
  installMethod: 'native',
  installPath: '/home/synthetic/.local/share/claude/versions/2.1.238',
  currentVersion: '2.1.238',
  latestVersion: '2.1.300',
  advisory: 'behind-latest',
  updateCommand: '/home/synthetic/.local/bin/claude update',
  canUpdate: true,
  message: null,
  checkedAt: '2026-11-20T00:00:00.000Z',
  run: IDLE_AGENT_CLI_UPDATE_RUN,
};

function executors(sources: Record<string, AgentCliUpdates | null>, seen: string[] = []): CliUpdateExecutors {
  return {
    integrationsFor(executorId) {
      seen.push(executorId);
      return { list: () => Object.entries(sources).map(([id, cliUpdates]) => ({ descriptor: { id }, cliUpdates })) };
    },
  };
}

function updates(overrides: Partial<AgentCliUpdates> = {}): AgentCliUpdates {
  return {
    status: async () => STATUS,
    startUpdate: async () => ({ ...STATUS, run: { ...IDLE_AGENT_CLI_UPDATE_RUN, state: 'running' } }),
    ...overrides,
  } satisfies AgentCliUpdates;
}

test('reports each agent that has a CLI and isolates failures per agent', async () => {
  const requests: AgentCliUpdateStatusRequest[] = [];
  const seen: string[] = [];
  const service = new AgentCliUpdateService(executors({
    claude: updates({ status: async (request) => { requests.push(request); return STATUS; } }),
    codex: updates({ status: async () => { throw new Error('codex --version timed out'); } }),
    shell: null,
  }, seen));
  const result = await service.statuses('remote-1', { refresh: true });
  expect(seen).toEqual(['remote-1']);
  expect(result).toEqual({ statuses: { claude: STATUS }, failures: { codex: 'codex --version timed out' } });
  expect(requests[0]!.refresh).toBe(true);
  expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
});

test('starts an update on the requested agent', async () => {
  let starts = 0;
  const service = new AgentCliUpdateService(executors({
    claude: updates({ startUpdate: async () => { starts++; return STATUS; } }),
  }));
  expect(await service.start('local', 'claude')).toEqual(STATUS);
  expect(starts).toBe(1);
});

test('maps unknown agents and unsupported installations to domain errors', async () => {
  const service = new AgentCliUpdateService(executors({
    claude: updates({
      startUpdate: async () => {
        throw new AgentIntegrationError('OPERATION_UNSUPPORTED', 'Update it with the tool that installed it.', false);
      },
    }),
    codex: updates({
      startUpdate: async () => { throw new AgentCallError('rejected', 'Bundled with Garcon.', 'OPERATION_UNSUPPORTED'); },
    }),
    shell: null,
  }));
  for (const [agentId, status, code] of [
    ['missing', 400, 'UNSUPPORTED_AGENT'],
    ['shell', 400, 'OPERATION_UNSUPPORTED'],
    ['claude', 409, 'OPERATION_UNSUPPORTED'],
    ['codex', 409, 'OPERATION_UNSUPPORTED'],
  ] as const) {
    const error = await service.start('local', agentId).catch((caught: unknown) => caught);
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ status, code });
  }
});
