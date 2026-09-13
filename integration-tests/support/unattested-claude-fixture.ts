import type { NodeSessionFixtureOptions } from './node-session-handshake-fixture.js';
import { createNodeSessionOutputFixture } from './node-session-output-fixture.js';
import { startWorkerSessionFixture } from './worker-session-fixture.js';
import { unattestedClaudeWorkerCommand } from './unattested-claude-command.js';
import type { TestCertificate } from './tls-certificates.js';

/** Exercises real Claude worker plumbing while its native turn lifetime remains unproven. */
export function createUnattestedClaudeSessionFixture(certificate: TestCertificate, options: NodeSessionFixtureOptions) {
  if (options.instance?.agentId !== 'claude') throw new Error('Unattested characterization requires Claude');
  return createNodeSessionOutputFixture(certificate, { ...options,
    maxOperations: Math.max(2, options.maxOperations ?? 2),
    sessionCommand: unattestedClaudeWorkerCommand('session'),
  });
}

export function startUnattestedClaudeWorkerFixture(instances: Parameters<typeof startWorkerSessionFixture>[0]) {
  if (instances.some((instance) => instance.agentId !== 'claude')) throw new Error('Unattested characterization requires Claude');
  return startWorkerSessionFixture(instances, undefined, unattestedClaudeWorkerCommand('session'));
}
