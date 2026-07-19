import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentIntegrationConformance } from '@garcon/server-agent-interface/testing';
import { defaultAgentIntegrations } from '../default-agent-integrations.js';
import { IntegrationHostFactory } from '../integration-host.js';
import { IntegrationRegistry } from '../integration-registry.js';

describe('default agent integration conformance', () => {
  let workspaceDir;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-agent-conformance-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('runs the required contract suite for every shipped integration', async () => {
    const hostFactory = new IntegrationHostFactory({
      workspaceDir,
      resolveCredential: async () => null,
      loadCarryOver: async ({ expectedRevision }) => ({ revision: expectedRevision, messages: [] }),
      readEnvironment: () => undefined,
      loggerFactory: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    });
    const registry = new IntegrationRegistry({
      integrations: defaultAgentIntegrations,
      hostFactory,
      migrationStoreFor: () => ({
        getVersion: async () => 0,
        read: async () => undefined,
        commit: async () => {},
      }),
    });

    for (const integrationClass of defaultAgentIntegrations) {
      await runAgentIntegrationConformance({
        integrationClass,
        integration: registry.require(integrationClass.integrationId),
      });
    }

    expect(registry.list().map((integration) => integration.descriptor.id)).toHaveLength(
      defaultAgentIntegrations.length,
    );
  });
});
