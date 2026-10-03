import { expect, test } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rejectionOf } from '../../support/promise-assertions.js';

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await access(path).then(() => true, () => false)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test('publishes a complete Codex approval response before exposing its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-response-publication-'));
  const held = join(root, 'write-held');
  const release = join(root, 'write-release');
  const control = 'approval.request.json';
  const response = join(root, `${control}.response.json`);
  const child = Bun.spawn([
    process.execPath,
    '--preload', fileURLToPath(new URL('../../support/hold-codex-response-write.ts', import.meta.url)),
    fileURLToPath(new URL('../../support/fake-codex-app-server.ts', import.meta.url)),
  ], {
    env: {
      CODEX_HOME: join(root, 'home'),
      INTEGRATION_CODEX_ROUTING_CONTROL_DIR: root,
      INTEGRATION_CODEX_WRITE_HELD: held,
      INTEGRATION_CODEX_WRITE_RELEASE: release,
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const lines = child.stdout.pipeThrough(new TextDecoderStream());
  const reader = lines.getReader();
  let output = '';
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ id: 1, method: 'thread/start', params: { cwd: root } });
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Codex fixture exited before thread creation: ${await stderr}`);
      output += chunk.value;
    }
    const thread = JSON.parse(output.split('\n')[0]).result.thread;
    send({ id: 2, method: 'turn/start', params: { threadId: thread.id, input: [] } });
    await writeFile(join(root, control), JSON.stringify({ target: 'started', requestId: 42, command: 'synthetic command' }));
    await waitForFile(join(root, `${control}.sent`));
    send({ id: 42, result: { decision: 'decline' } });
    await waitForFile(held);
    expect(await rejectionOf(access(response))).toMatchObject({ code: 'ENOENT' });
    await writeFile(release, 'release');
    await waitForFile(response);
    expect(JSON.parse(await readFile(response, 'utf8'))).toEqual({ result: { decision: 'decline' }, error: null });
  } finally {
    await writeFile(release, 'release');
    child.stdin.end();
    child.kill('SIGKILL');
    await child.exited;
    await reader.cancel();
    await stderr;
    await rm(root, { recursive: true, force: true });
  }
});
