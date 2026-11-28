import type { ExecutorAvailability } from '../../../server-agents/interface/src/contracts/execution-runtime.ts';
import type { ExecutorRpcMethods } from '../../../server/remote/transport/rpc-protocol.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

// ExecutionRuntime constructs projectBasePath before integrationIds.
const info: ExecutorRpcMethods['executor.describe']['result']['info'] = {
  executorId: 'fixture-executor', instanceId: 'fixture-instance', projectBasePath: '/work',
  integrationIds: ['claude', 'codex'],
  services: { files: true, git: true, gh: false, terminals: false, directoryCreation: true },
};
const availability: ExecutorAvailability[] = ['ready', 'reconnecting', 'offline', 'disposed'];
const discovery: ExecutorRpcMethods['apiProviders.discoverModels']['request'][] = [
  { protocol: 'openai-compatible', baseUrl: 'https://example.invalid/v1', modelDiscovery: 'openai-models' },
  { protocol: 'openai-compatible', baseUrl: 'https://example.invalid/v1', apiKey: '', modelDiscovery: 'openai-models' },
];
const inspect: ExecutorRpcMethods['projects.inspect']['request'][] = [
  { projectPath: '/work/app', includeGitRepository: false },
  { projectPath: '/work/app' },
];
const inspected: ExecutorRpcMethods['projects.inspect']['result'][] = [
  { resolution: { kind: 'available', effectiveProjectKey: '/work/app' }, isGitRepository: true },
  { resolution: { kind: 'unavailable', reason: 'not-found' } },
];
const ticket: ExecutorRpcMethods['projects.ticketProjectDefault']['request'] = { projectPath: '/work/app' };
const ticketProject: ExecutorRpcMethods['projects.ticketProjectDefault']['result'][] = [
  { project: '/work/app', kind: 'folder' },
  { project: 'owner/repo', kind: 'repository' },
];
const mentions: ExecutorRpcMethods['projects.resolveFileMentions']['request'] = { projectPath: '/work/app', command: '@README.md' };
const resolved: ExecutorRpcMethods['projects.resolveFileMentions']['result'] = 'Synthetic referenced file content.\n';

for (const value of [info, ...availability, ...discovery, ...inspect, ...inspected, ticket, ...ticketProject, mentions, resolved]) {
  console.log(JSON.stringify(value));
}
