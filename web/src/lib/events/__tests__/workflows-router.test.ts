import { expect, it, vi } from 'vitest';
import { WsConnection } from '$lib/ws/connection.svelte';
import { WorkflowsRouter } from '../workflows-router';

it('filters malformed invalidations, drains exactly once, and detaches cleanly', () => {
  const connection = new WsConnection(); const invalidate = vi.fn();
  const router = new WorkflowsRouter(connection, invalidate); router.start();
  connection.messages.push(...[
    { type: 'workflow-invalidated', workflowId: 'synthetic-workflow', revision: 1 },
    { type: 'workflow-invalidated', workflowId: 'synthetic-workflow', revision: -1 },
    { type: 'workflow-invalidated', workflowId: 'synthetic-workflow', revision: 2, extra: true },
  ].map(data => ({ data, timestamp: 0 })));
  router.tick(); router.tick();
  expect(invalidate).toHaveBeenCalledExactlyOnceWith('synthetic-workflow');
  router.destroy();
  connection.messages.push({ data: { type: 'workflow-invalidated', workflowId: 'synthetic-workflow', revision: 3 }, timestamp: 0 });
  router.tick(); expect(invalidate).toHaveBeenCalledTimes(1); connection.disconnect();
});
