import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.each(['configuration', 'repository overrides'])('fixture Git ignores inherited %s', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'garcon-git-fixture-isolation-'));
  try {
    const project = join(root, 'project');
    const hooks = join(root, 'hooks');
    await mkdir(project);
    await mkdir(hooks);
    const marker = join(root, 'hook-executed');
    const config = join(root, 'user.gitconfig');
    await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\nprintf invoked > '${marker}'\n`);
    await chmod(join(hooks, 'pre-commit'), 0o755);
    await writeFile(config, `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = /bin/false\n`);
    if (scenario === 'repository overrides') await writeFile(config, '');
    const overrides = scenario === 'configuration' ? {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Inherited author',
    } : {
      GIT_DIR: join(root, 'wrong.git'), GIT_WORK_TREE: root,
      GIT_INDEX_FILE: join(root, 'wrong-index'), GIT_OBJECT_DIRECTORY: join(root, 'wrong-objects'),
    };
    const source = `
      import { initializeFixtureRepository, runFixtureGit } from ${JSON.stringify(new URL('../../support/git-fixture.ts', import.meta.url).href)};
      await initializeFixtureRepository(${JSON.stringify(project)});
      console.log(await runFixtureGit(${JSON.stringify(project)}, 'log', '-1', '--format=%an'));
    `;
    const child = Bun.spawn([process.execPath, '-e', source], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_SYSTEM: config,
        ...overrides,
      },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout.trim()).toBe('Git Fixture');
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(join(root, 'wrong-index')).exists()).toBe(false);
    expect(await Bun.file(join(project, '.git/HEAD')).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
