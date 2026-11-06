import { expect, test } from 'bun:test';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { AutomationLifecycle, type AutomationMutation } from '../lifecycle.js';
import { ChatMutationGuard } from '../mutation-guard.js';

test.each<AutomationMutation>(['execution-settings', 'project', 'view-replaced'])('revokes %s under the shared chat lock before effects', async action => {
  const lock = new KeyedPromiseLock();
  const lifecycle = new AutomationLifecycle();
  const lease = lifecycle.acquire({ serverInstanceId: 'synthetic', chatId: 'chat', turnId: 'turn', clientRequestId: 'request' });
  const guard = new ChatMutationGuard(lock, lifecycle);
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const holder = lock.runExclusive('chat:chat', async () => { entered.resolve(); await held.promise; });
  await entered.promise;
  let applied = false;
  const mutation = guard.run('chat', action, async beforeMutation => {
    expect(lease.revoked.aborted).toBe(false);
    beforeMutation();
    expect(lease.revoked.aborted).toBe(true);
    applied = true;
  });
  expect(applied).toBe(false);
  expect(lease.revoked.aborted).toBe(false);
  held.resolve();
  await holder;
  await mutation;
  expect(applied).toBe(true);
  lease.release();
});
