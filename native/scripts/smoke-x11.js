import assert from 'node:assert/strict';

assert.ok(process.env.DISPLAY, 'Run inside a dedicated X server with xvfb-run -a');
const hasWindowManager = () => Bun.spawnSync(['xdotool', 'get_desktop']).exitCode === 0;
assert.ok(!hasWindowManager(), 'The smoke display must not already have a window manager');
const manager = Bun.spawn(['openbox', '--sm-disable'], { stdout: 'inherit', stderr: 'inherit' });
try {
  const deadline = Date.now() + 10_000;
  while (!hasWindowManager()) {
    assert.equal(manager.exitCode, null, 'Openbox exited before becoming ready');
    assert.ok(Date.now() < deadline, 'Openbox did not become ready');
    await Bun.sleep(50);
  }
  const smoke = Bun.spawn(['bun', `${import.meta.dir}/smoke.js`], { stdout: 'inherit', stderr: 'inherit' });
  process.exitCode = await smoke.exited;
} finally {
  manager.kill();
  await manager.exited;
}
