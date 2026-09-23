import { expect, test, mock, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import createGitRoutes from '../git.js';
import { LocalGitRuntime } from '../../git/node-service.js';
import { runGit } from '../../git/run.js';

test('body-routed Git operations reject URL targets before resolving any node or generator', async () => {
  const resolveGit = mock(() => { throw new Error('unexpected node resolution'); });
  const getUiSettings = mock(() => { throw new Error('unexpected generation lookup'); });
  const routes = createGitRoutes({}, { getUiSettings }, resolveGit);
  for (const [route, handlers] of Object.entries(routes)) {
    if (!handlers.POST) continue;
    const url = new URL(`http://localhost${route}?nodeId=00000000-0000-4000-8000-000000000001`);
    const request = new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: '/project', message: 'synthetic commit', files: ['file.txt'] }),
    });
    const response = await handlers.POST(request, url);
    const body = await response.json();
    expect(body.error).toBe('Git body-routed requests do not accept query parameters');
    expect({ route, status: response.status, code: body.errorCode })
      .toEqual({ route, status: 400, code: 'GIT_INVALID_INPUT' });
  }
  expect(resolveGit).not.toHaveBeenCalled();
  expect(getUiSettings).not.toHaveBeenCalled();
});

test('deadline during repository validation remains a timeout at the HTTP boundary', async () => {
  const parent = path.join(os.homedir(), 'tmp');
  await fs.mkdir(parent, { recursive: true });
  const projectPath = await fs.mkdtemp(path.join(parent, 'git-route-timeout-'));
  const runtime = new LocalGitRuntime({ nodeId: 'local', instanceId: 'test', projectBasePath: projectPath, assertAvailable() {} });
  let spawn;
  try {
    await runGit(projectPath, ['init', '-b', 'main']);
    const original = Bun.spawn;
    let heldProbe = false;
    spawn = spyOn(Bun, 'spawn').mockImplementation((args, options) => {
      if (!args.includes('--is-inside-work-tree')) return original(args, options);
      heldProbe = true;
      return original([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], options);
    });
    const routes = createGitRoutes({}, {}, async () => runtime.git, 1_000);
    const url = new URL('http://localhost/api/v1/git/remotes');
    url.searchParams.set('project', projectPath);
    const response = await routes[url.pathname].GET(new Request(url), url);
    expect(heldProbe).toBe(true);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ errorCode: 'GIT_TIMEOUT' });
  } finally {
    spawn?.mockRestore();
    runtime.dispose();
    await fs.rm(projectPath, { recursive: true, force: true });
  }
});
