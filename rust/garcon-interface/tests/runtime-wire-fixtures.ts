import type { AgentMigrationStore } from '../../../server-agents/interface/src/contracts/host.ts';
import type { ExecutorRpcMethods } from '../../../server/remote/transport/rpc-protocol.ts';

if (Bun.version !== '1.4.3') throw new Error(`expected Bun 1.4.3, got ${Bun.version}`);

const refresh: ExecutorRpcMethods['cliUpdates.status']['request'] = { refresh: true };
const credential: ExecutorRpcMethods['credentials.resolve']['result'] = { kind: 'api-key', value: 'synthetic-credential' };
const migration: Parameters<AgentMigrationStore['commit']>[0] = {
  expectedVersion: 0, nextVersion: 1,
  set: { fixture: JSON.parse('{"n":1.0,"big":9007199254740993,"exp21":1e21,"negativeZero":-0}') },
  delete: ['obsolete'],
};

const resolve: ExecutorRpcMethods['credentials.resolve']['request'] = {
  reference: { kind: 'api-provider-endpoint', apiProviderId: 'fixture-provider', endpointId: 'main', revision: 3 },
};
const update: ExecutorRpcMethods['cliUpdates.startUpdate']['result'] = {
  cliLabel: 'Fixture CLI', installMethod: 'native', installPath: '/bin/fixture', currentVersion: '2.1.0',
  latestVersion: '2.2.0', advisory: 'behind-latest', updateCommand: 'fixture update',
  canUpdate: true, message: null, checkedAt: '2026-11-20T00:00:00.000Z',
  run: { state: 'running', startedAt: '2026-11-20T00:00:00.000Z', finishedAt: null, message: 'Updating', output: null },
};
const usageRead: ExecutorRpcMethods['usageHistory.read']['request'] = {
  sinceDay: '2026-10-26', untilDay: '2026-10-27', timeZone: '+05:45',
};
const usage: ExecutorRpcMethods['usageHistory.read']['result'] = {
  status: 'missing', buckets: [], scannedFiles: 0, unreadableFiles: 0, malformedRecords: 0,
  distinctSessions: 0, pricingAsOf: '2026-10-27',
};
const discovered: ExecutorRpcMethods['apiProviders.discoverModels']['result'] = { success: false, error: 'Synthetic failure' };

for (const value of [refresh, credential, migration, resolve, update, usageRead, usage, discovered, null]) {
  console.log(JSON.stringify(value));
}
