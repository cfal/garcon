import { ProcessExitFence } from '../../../../server-agents/common/src/lifecycle/process-exit-fence.ts';

const child = Bun.spawn(['sh', '-c', Bun.argv[2]!], { stdout: 'pipe' });
try {
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  if (ready.done || ready.value[0] !== 33) throw new Error('Child did not become ready');
  const fence = new ProcessExitFence();
  let exitCallbacks = 0;
  const exited = await fence.terminate('session', child, () => { exitCallbacks += 1; });
  fence.assertClear('session');
  await fence.wait('session');
  process.stdout.write(JSON.stringify({ exited, exitCallbacks }));
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await child.exited;
}
