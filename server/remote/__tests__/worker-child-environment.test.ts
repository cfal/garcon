import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

test.skipIf(process.platform === 'win32')('provider and machine children cannot inherit the consumed native controller credential', async () => {
  const temporary = join(homedir(), 'tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'worker-child-environment-'));
  const capture = join(root, 'children.jsonl');
  const source = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.ENV_CAPTURE, JSON.stringify({
  args, credential: process.env.GARCON_CONTROLLER_URL ?? null,
  sentinel: process.env.ENV_SENTINEL,
}) + '\\n');
if (args.includes('--device-auth')) {
  console.log('https://login.example.test/activate\\n  AAAA-BBBB\\n');
  setInterval(() => {}, 1000);
} else if (args.includes('--version')) console.log('99.0.0');
else if (args[0] === 'usage') console.log('Signed in as synthetic@example.test');
else if (args[0] === 'auth') console.log(JSON.stringify({ loggedIn: true }));
else if (args[0] === 'status') console.log(JSON.stringify({ authenticated: true }));
else if (args.includes('-x')) console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'synthetic' }] } }));
else console.log('synthetic');
`;
  try {
    for (const name of ['provider', 'codex', 'gh']) {
      const filename = join(root, name);
      await Bun.write(filename, source);
      await chmod(filename, 0o700);
    }
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/worker-child-environment.ts'), root], {
      env: {
        PATH: `${root}${delimiter}${process.env.PATH ?? ''}`, HOME: root,
        GARCON_CONTROLLER_URL: `wss://controller.test/executor#secret=${Buffer.alloc(32, 7).toString('base64url')}`,
        GARCON_CODEX_CLI: join(root, 'codex'), ENV_CAPTURE: capture, ENV_SENTINEL: 'preserved',
      },
      stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(10_000),
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    const records = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(8);
    for (const record of records) {
      expect(record.sentinel).toBe('preserved');
      expect(record.credential).toBe(record.args.includes('--device-auth') ? '' : null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
