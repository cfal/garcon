import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { imageIndex } from '../docker-release.js';

const sourceCommit = 'a'.repeat(40);
const repository = 'Synthetic/Project';
const raw = JSON.stringify({ manifests: ['amd64', 'arm64'].map((architecture, index) => ({
  platform: { os: 'linux', architecture }, digest: `sha256:${String(index).repeat(64)}`,
})) });
const digest = imageIndex(raw).digest;
const image = 'ghcr.io/synthetic/project';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'release-cli-'));
  try {
    const stub = `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';
const responses = JSON.parse(await Bun.file(process.env.RESPONSES).text());
const key = JSON.stringify(process.argv.slice(2));
appendFileSync(process.env.CALLS, key + '\\n');
const response = responses[key];
if (!response) throw new Error('Unexpected command: ' + key);
process.stdout.write(response.stdout ?? '');
process.stderr.write(response.stderr ?? '');
process.exit(response.code ?? 0);\n`;
    for (const tool of ['gh', 'docker']) {
      await writeFile(join(directory, tool), stub);
      await chmod(join(directory, tool), 0o755);
    }
    const execute = async (script, intent, responses, env = {}) => {
      const path = join(directory, 'responses.json');
      const output = join(directory, 'output');
      const calls = join(directory, 'calls');
      await writeFile(path, JSON.stringify(Object.fromEntries(responses.map(([args, response]) => [JSON.stringify(args), response]))));
      await writeFile(output, '');
      await writeFile(calls, '');
      const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, `../${script}.js`), intent], {
        env: { PATH: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`, RESPONSES: path, CALLS: calls,
          GITHUB_OUTPUT: output, GITHUB_REPOSITORY: repository, GITHUB_SHA: 'b'.repeat(40),
          SOURCE_SHA: sourceCommit, IMAGE: image, ...env }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(await readFile(calls, 'utf8')).toBe(responses.map(([args]) => `${JSON.stringify(args)}\n`).join(''));
      return { code: result.exitCode, error: result.stderr.toString(), output: await readFile(output, 'utf8') };
    };
    await run(execute);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('source CLI binds release ID/tag and writes resolved SHA and lowercase image outputs', () => fixture(async execute => {
  const json = value => ({ stdout: JSON.stringify(value) });
  const routes = [
    [['api', `repos/${repository}/releases/7`], json({ id: 7, tag_name: 'v0.4.0', draft: false, published_at: '2026-01-01',
      assets: [{ id: 9, name: 'release-manifest.json' }] })],
    [['api', `repos/${repository}/git/ref/tags/v0.4.0`], json({ object: { type: 'commit', sha: sourceCommit } })],
    [['api', `repos/${repository}/releases/assets/9`, '-H', 'Accept: application/octet-stream'], json({
      schemaVersion: 1, repository, sourceCommit, tag: 'v0.4.0', version: '0.4.0',
    })],
  ];
  const result = await execute('release-github', 'source', routes,
    { GITHUB_EVENT_NAME: 'release', RELEASE_ID: '7', RELEASE_TAG: 'v0.4.0' });
  expect(result).toEqual({ code: 0, error: '', output: `sha=${sourceCommit}\nimage=${image}\n` });
  const main = await execute('release-github', 'source', [], { GITHUB_EVENT_NAME: 'push' });
  expect(main.output).toBe(`sha=${'b'.repeat(40)}\nimage=${image}\n`);
  expect(main.code).toBe(0);
  const denied = await execute('release-github', 'source', [[routes[0][0], { code: 1, stderr: 'API denied' }]],
    { GITHUB_EVENT_NAME: 'release', RELEASE_ID: '7', RELEASE_TAG: 'v0.4.0' });
  expect(denied.code).not.toBe(0);
  expect(denied.output).toBe('');
  expect(denied.error).toContain('API denied');
}));

test('Docker CLI reports reuse, absence, and verified built/existing digests without swallowing failures', () => fixture(async execute => {
  const inspect = reference => ['buildx', 'imagetools', 'inspect', '--raw', reference];
  const existing = await execute('docker-release', 'find', [[inspect(`${image}:sha-${sourceCommit}`), { stdout: raw }]]);
  expect(existing).toEqual({ code: 0, error: '', output: `exists=true\ndigest=${digest}\n` });
  const absent = await execute('docker-release', 'find', [[inspect(`${image}:sha-${sourceCommit}`), { code: 1, stderr: 'manifest unknown' }]]);
  expect(absent).toEqual({ code: 0, error: '', output: 'exists=false\n' });
  for (const env of [{ BUILT_DIGEST: digest }, { EXISTING_DIGEST: digest, BUILT_DIGEST: 'must-not-use' }]) {
    const result = await execute('docker-release', 'resolve', [[inspect(`${image}@${digest}`), { stdout: raw }]], env);
    expect(result).toEqual({ code: 0, error: '', output: `digest=${digest}\n` });
  }
  const invalid = await execute('docker-release', 'resolve', [], { BUILT_DIGEST: 'bad' });
  expect(invalid.code).not.toBe(0);
  expect(invalid.output).toBe('');
  expect(invalid.error).toContain('Invalid publication digest');
}));
