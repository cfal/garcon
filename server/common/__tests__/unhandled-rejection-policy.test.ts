import { expect, test } from 'bun:test';

test('reports detached rejection without terminating unrelated work', async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/unhandled-rejection.ts`], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output.trim().split('\n')).toEqual([
    JSON.stringify({ type: 'unhandled-rejection', details: ['unhandled rejection (non-fatal):', 'synthetic detached failure'] }),
    'still-alive',
  ]);
});

test('uninstall removes only the policy listener and is idempotent', async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/unhandled-rejection.ts`, 'remove'], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  });
  expect(await new Response(child.stdout).text()).toBe('{"listenersRestored":true}\n');
  expect(await child.exited).toBe(0);
});
