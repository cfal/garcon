import { expect, test } from 'bun:test';
import {
  AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS,
  parseAgentCliUpdatesResponse,
  parseAgentCliUpdateStatus,
} from '../agent-cli-update.ts';

const STATUS = {
  installMethod: 'native',
  installPath: '/home/synthetic/.local/share/claude/versions/2.1.300',
  currentVersion: '2.1.300',
  latestVersion: '2.1.300',
  advisory: 'current',
  updateCommand: '/home/synthetic/.local/bin/claude update',
  canUpdate: true,
  message: null,
  checkedAt: '2026-11-20T00:00:00.000Z',
  run: {
    state: 'succeeded',
    startedAt: '2026-11-20T00:00:00.000Z',
    finishedAt: '2026-11-20T00:01:00.000Z',
    message: 'Updated Claude Code to 2.1.300.',
    output: 'Successfully updated',
  },
};

test('round-trips a CLI update status', () => {
  expect(parseAgentCliUpdateStatus(JSON.parse(JSON.stringify(STATUS)))).toEqual(STATUS);
  expect(parseAgentCliUpdatesResponse({ statuses: { claude: STATUS }, failures: { codex: 'Timed out' } }))
    .toEqual({ statuses: { claude: STATUS }, failures: { codex: 'Timed out' } });
});

test('rejects statuses outside the contract', () => {
  for (const invalid of [
    { ...STATUS, installMethod: 'apt' },
    { ...STATUS, advisory: 'stale' },
    { ...STATUS, canUpdate: 'yes' },
    { ...STATUS, checkedAt: 'yesterday' },
    { ...STATUS, currentVersion: 2 },
    { ...STATUS, run: { ...STATUS.run, state: 'queued' } },
    { ...STATUS, run: { ...STATUS.run, output: 'x'.repeat(AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS + 1) } },
    { ...STATUS, run: undefined },
  ]) {
    expect(parseAgentCliUpdateStatus(invalid)).toBeNull();
  }
  expect(parseAgentCliUpdatesResponse({ statuses: { claude: { ...STATUS, advisory: 'stale' } }, failures: {} })).toBeNull();
  expect(parseAgentCliUpdatesResponse({ statuses: {}, failures: { codex: 7 } })).toBeNull();
  expect(parseAgentCliUpdatesResponse({ statuses: {} })).toBeNull();
});
