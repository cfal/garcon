import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectAgentBuildContributions } from '../agent-build-metadata.js';
import { defaultAgentIntegrations } from '../../server/agents/default-agent-integrations.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function createFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-build-metadata-'));
  temporaryDirectories.push(root);
  const serverDir = path.join(root, 'server');
  const packageDir = path.join(root, 'server-agents', 'fixture');
  const dependencyDir = path.join(root, 'dependencies', 'fixture-sdk');
  await mkdir(path.join(serverDir, 'node_modules', '@garcon'), { recursive: true });
  await mkdir(path.join(packageDir, 'src'), { recursive: true });
  await mkdir(dependencyDir, { recursive: true });
  await writeFile(path.join(packageDir, 'src', 'index.ts'), 'export default class Fixture {}\n');
  await writeFile(path.join(packageDir, 'src', 'worker.ts'), 'postMessage({ type: "ready" });\n');
  await writeFile(path.join(packageDir, 'src', 'prepare.ts'), 'globalThis.__fixturePrepared = true;\n');
  await writeFile(path.join(dependencyDir, 'index.js'), 'export {};\n');
  await writeFile(path.join(dependencyDir, 'package.json'), JSON.stringify({
    name: 'fixture-sdk',
    type: 'module',
    exports: './index.js',
  }));
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@garcon/server-agent-fixture',
    type: 'module',
    exports: './src/index.ts',
    dependencies: options.declareSdk === false ? {} : { 'fixture-sdk': '1.0.0' },
    garconBuild: options.garconBuild ?? {
      apiVersion: 2,
      integrationId: 'fixture',
      standaloneEntrypoints: { 'transcript-index-source': './src/worker.ts' },
      preMainModules: ['./src/prepare.ts'],
      embeddedDependencyMetadata: ['fixture-sdk/package.json'],
    },
  }));
  await writeFile(path.join(serverDir, 'package.json'), JSON.stringify({
    dependencies: { '@garcon/server-agent-fixture': 'workspace:*' },
  }));
  await symlink(packageDir, path.join(serverDir, 'node_modules', '@garcon', 'server-agent-fixture'));
  await mkdir(path.join(packageDir, 'node_modules'), { recursive: true });
  await symlink(dependencyDir, path.join(packageDir, 'node_modules', 'fixture-sdk'));
  return { root, serverDir, packageDir };
}

describe('collectAgentBuildContributions', () => {
  test('resolves every contribution declared by the repository packages', async () => {
    const contributions = await collectAgentBuildContributions();
    expect(contributions.map((entry) => entry.integrationId).sort()).toEqual(
      defaultAgentIntegrations.map((entry) => entry.integrationId).sort(),
    );
  });

  test('resolves validated package-owned contributions', async () => {
    const fixture = await createFixture();
    const [contribution] = await collectAgentBuildContributions({
      repoRoot: fixture.root,
      serverPackagePath: path.join(fixture.serverDir, 'package.json'),
    });
    expect(contribution.integrationId).toBe('fixture');
    expect(contribution.packageRoot).toBe(fixture.packageDir);
    expect(contribution.standaloneEntrypoints).toEqual({
      'transcript-index-source': path.join(fixture.packageDir, 'src', 'worker.ts'),
    });
    expect(contribution.preMainModules).toEqual([
      path.join(fixture.packageDir, 'src', 'prepare.ts'),
    ]);
    expect(contribution.embeddedDependencyMetadata).toEqual([
      path.join(fixture.root, 'dependencies', 'fixture-sdk', 'package.json'),
    ]);
    const result = await Bun.build({
      entrypoints: Object.values(contribution.standaloneEntrypoints),
      target: 'bun',
      format: 'esm',
    });
    expect(result.success).toBe(true);
  });

  test('rejects undeclared embedded dependencies', async () => {
    const fixture = await createFixture({ declareSdk: false });
    await expect(collectAgentBuildContributions({
      repoRoot: fixture.root,
      serverPackagePath: path.join(fixture.serverDir, 'package.json'),
    })).rejects.toThrow('references undeclared dependency fixture-sdk');
  });

  test('rejects a contribution that resolves outside its package', async () => {
    const fixture = await createFixture({
      garconBuild: {
        apiVersion: 2,
        integrationId: 'fixture',
        standaloneEntrypoints: { 'transcript-index-source': './src/escaped.ts' },
        preMainModules: [],
        embeddedDependencyMetadata: [],
      },
    });
    await writeFile(path.join(fixture.root, 'escaped.ts'), 'export {};\n');
    await symlink(path.join(fixture.root, 'escaped.ts'), path.join(fixture.packageDir, 'src', 'escaped.ts'));
    await expect(collectAgentBuildContributions({
      repoRoot: fixture.root,
      serverPackagePath: path.join(fixture.serverDir, 'package.json'),
    })).rejects.toThrow('escapes its package');
  });
});
