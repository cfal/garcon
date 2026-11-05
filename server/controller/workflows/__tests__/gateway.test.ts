import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { GarconClient } from '../../../../cli/garcon-client.js';
import { discoverRuntime } from '../../../../cli/discovery.js';
import { CLI_OPERATIONS } from '../../../remote/transport/cli-protocol.js';
import { cliPair } from '../../../remote/__tests__/cli-fixture.js';
import { startCliGateway } from '../../../remote/server/cli-gateway.js';
import { ControllerCliDispatcher } from '../../executors/cli-dispatcher.js';
import { DomainError } from '../../../common/domain-error.js';
import { createWorkflowRoutes } from '../routes.js';
import { fixture, plan } from './fixture.js';

test('workflow gateway preserves drafts, reads, control intents and exact operation recovery without approval authority', async () => {
  const f = fixture();
  let allowed = true;
  const pair = cliPair(new ControllerCliDispatcher({ routes: createWorkflowRoutes(f), serverInstanceId: 'synthetic-controller',
    workspaceName: 'synthetic-workspace', isShuttingDown: () => false }), () => {
    if (!allowed) throw new DomainError('CLI_ACCESS_DENIED', 'Grant revoked', 403);
  });
  const gateway = await startCliGateway({ dataDir: join(f.directory, 'executor'), currentConnection: () => pair.connection });
  try {
    const client = new GarconClient(await discoverRuntime({ configDir: f.directory, runtime: 'executor' }));
    const bootstrap = await client.getWorkflowBootstrap();
    expect(bootstrap).toEqual(f.service.bootstrap());
    const request = { expectedStoreId: bootstrap.storeId, operationId: crypto.randomUUID(),
      mutation: { action: 'create' as const, plan: plan(), captainChatId: null } };
    const created = await client.mutateWorkflow(request);
    expect(await client.mutateWorkflow(request)).toEqual(created);
    expect(await client.getWorkflowOperation(request.operationId)).toEqual({ kind: 'completed', result: created });
    expect(await client.readWorkflow({ kind: 'show', id: created.workflowId })).toEqual(f.service.overview(created.workflowId));
    expect(await client.readWorkflow({ kind: 'plan', id: created.workflowId, planRevision: 1 })).toEqual(f.service.plan(created.workflowId, 1));
    const updated = await client.mutateWorkflow({ expectedStoreId: bootstrap.storeId, operationId: crypto.randomUUID(),
      mutation: { action: 'plan', workflowId: created.workflowId, expectedPlanRevision: 1, plan: { ...plan(), title: 'Staged update' } } });
    expect(updated.workflowId).toBe(created.workflowId);
    for (const action of ['pause', 'stop'] as const) {
      await client.mutateWorkflow({ expectedStoreId: bootstrap.storeId, operationId: crypto.randomUUID(), mutation: { action, workflowId: created.workflowId } });
      expect(f.service.detail(created.workflowId).workflow.desired).toBe('paused');
      expect(CLI_OPERATIONS[`POST /api/v1/workflows/${action}`].lane).toBe('primary');
    }
    for (const action of ['activate', 'approve', 'resume', 'retry', 'resolve', 'clear-hold', 'recheck-publication', 'cleanup', 'cancel', 'archive']) {
      expect(Object.hasOwn(CLI_OPERATIONS, `POST /api/v1/workflows/${action}`)).toBe(false);
      const response = await fetch(`${gateway.descriptor.baseUrl}/api/v1/workflows/${action}`, {
        method: 'POST', headers: { Authorization: `Bearer ${gateway.descriptor.localCapability}`, 'Content-Type': 'application/json',
          'X-Garcon-Server-Instance': 'synthetic-controller' }, body: JSON.stringify(request),
      });
      expect(response.status).toBe(403);
    }
    allowed = false;
    await expect(client.getWorkflowOperation(request.operationId)).rejects.toThrow('Grant revoked');
    await expect(client.mutateWorkflow(request)).rejects.toThrow('Grant revoked');
    expect(f.service.list().workflows).toHaveLength(1);
  } finally { await gateway.dispose(); pair.close(); f.cleanup(); }
});
