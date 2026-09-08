import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  commonArchitectureErrors,
  extractModuleSpecifiers,
} from '../common-architecture.js';

const repositoryRoot = path.resolve(import.meta.dir, '../..');
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createRepositoryFixture(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-common-architecture-'));
  temporaryDirectories.push(root);
  const files = {
    'common/package.json': JSON.stringify({
      exports: {
        './base': './base.ts',
        './client/shared': './client/shared.ts',
      },
    }),
    'common/base.ts': 'export interface Base { readonly value: string }',
    'common/client/shared.ts': "import type { Base } from '../base.js'; export type Shared = Base;",
    'server/index.ts': "import type { Base } from '@garcon/common/base'; export type ServerBase = Base;",
    'server-agents/sample/index.ts': 'export const agent = true;',
    ...overrides,
  };
  for (const [relativePath, source] of Object.entries(files)) {
    const fileName = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fileName), { recursive: true });
    await fs.writeFile(fileName, source);
  }
  return root;
}

describe('common architecture', () => {
  test('recognizes every supported module edge syntax', () => {
    expect(extractModuleSpecifiers(`
      import type {
        /* retained syntax edge */
        A,
      } from './a.js';
      import './side-effect.js';
      export { B } from './b.js';
      export type { C } from './c.js';
      const dynamic = await import('./dynamic.js');
      type Imported = import('./import-type.js').Imported;
      type ImportedModule = typeof import('./typeof-import.js');
      import Legacy = require('./import-equals.cjs');
      const required = require('./required.cjs');
      vi.mock('./mocked.js', () => ({}));
      mock.module('./bun-mocked.js', () => ({}));
      void dynamic;
      void required;
    `)).toEqual([
      './a.js',
      './side-effect.js',
      './b.js',
      './c.js',
      './dynamic.js',
      './import-type.js',
      './typeof-import.js',
      './import-equals.cjs',
      './required.cjs',
      './mocked.js',
      './bun-mocked.js',
    ]);
  });

  test('reads both Svelte scripts without matching comments or strings', () => {
    expect(extractModuleSpecifiers(`
      <script context="module">
        export { moduleValue } from './module.js';
      </script>
      <script lang="ts">
        import type { Instance } from './instance.js';
        // import './commented.js';
        const ignored = "import './string.js'";
      </script>
    `, 'Fixture.svelte')).toEqual(['./module.js', './instance.js']);
    expect(extractModuleSpecifiers(`
      import type {
        A,
      } from /* before specifier */ './trailing.js';
      // export { B } from './commented.js';
      const ignored = "require('./string.cjs')";
    `)).toEqual(['./trailing.js']);
  });

  test('allows canonical inward dependencies', async () => {
    const root = await createRepositoryFixture({
      'common/root.ts': "export type { Base } from '@garcon/common/base';",
      'common/client/relative.ts': "import type { Base } from '../base.js'; export type Value = Base;",
      'common/client/package.ts': "import type { Base } from '@garcon/common/base'; export type Value = Base;",
    });
    expect(await commonArchitectureErrors(root)).toEqual([]);
  });

  test('rejects root-common and server dependencies on client modules', async () => {
    const root = await createRepositoryFixture({
      'common/root.ts': `
        import type { Shared } from '@garcon/common/client/shared';
        type Relative = import('./client/shared.js').Shared;
        export type Value = Shared | Relative;
      `,
      'server/index.ts': `
        type PackageValue = typeof import('@garcon/common/client/shared');
        type AliasValue = import('$shared/client/shared').Shared;
        export type Value = PackageValue | AliasValue;
      `,
    });
    const errors = await commonArchitectureErrors(root);
    expect(errors).toContain('common/root.ts cannot import @garcon/common/client/shared');
    expect(errors).toContain('common/root.ts cannot import ./client/shared.js');
    expect(errors).toContain('server/index.ts cannot import @garcon/common/client/shared');
    expect(errors).toContain('server/index.ts cannot import $shared/client/shared');
  });

  test('keeps client helpers independent of runtimes and application implementations', async () => {
    const root = await createRepositoryFixture({
      'common/client/bad.ts': `
        import 'node:crypto';
        import 'bun:test';
        import '../../web/src/lib/example.js';
        import '@garcon/server-agent-common/search/query';
      `,
      'common/root.ts': `
        import '../cli/example.js';
        import '$lib/example.js';
        import '@garcon/server-agent-interface';
      `,
    });
    const errors = await commonArchitectureErrors(root);
    for (const specifier of [
      'node:crypto',
      'bun:test',
      '../../web/src/lib/example.js',
      '@garcon/server-agent-common/search/query',
    ]) {
      expect(errors).toContain(`common/client/bad.ts cannot import ${specifier}`);
    }
    for (const specifier of [
      '../cli/example.js',
      '$lib/example.js',
      '@garcon/server-agent-interface',
    ]) {
      expect(errors).toContain(`common/root.ts cannot import ${specifier}`);
    }
  });

  test('audits retired paths in application sources, mocks, and benchmarks', async () => {
    const root = await createRepositoryFixture({
      'cli/legacy.ts': "import '@garcon/common/start-selection';",
      'web/src/legacy.test.ts': "vi.mock('$shared/client-chat-id', () => ({}));",
      'web/scripts/benchmark.ts': "import '../../common/chat-filter-query.js';",
      'server/legacy.test.ts': "mock.module('@garcon/common/agent-settings', () => ({}));",
    });
    expect(await commonArchitectureErrors(root)).toEqual(expect.arrayContaining([
      'cli/legacy.ts uses retired import @garcon/common/start-selection',
      'server/legacy.test.ts uses retired import @garcon/common/agent-settings',
      'web/scripts/benchmark.ts uses retired import ../../common/chat-filter-query.js',
      'web/src/legacy.test.ts uses retired import $shared/client-chat-id',
    ]));
  });

  test('fails when required production roots are absent or empty', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-common-architecture-empty-'));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, 'common'), { recursive: true });
    await fs.writeFile(path.join(root, 'common/package.json'), JSON.stringify({ exports: {} }));
    const errors = await commonArchitectureErrors(root);
    expect(errors).toEqual(expect.arrayContaining([
      'Common architecture scan root has no production files: common',
      'Common architecture scan root is missing: server',
      'Common architecture scan root is missing: server-agents',
    ]));
  });

  test('keeps the repository dependency graph pointed inward', async () => {
    expect(await commonArchitectureErrors(repositoryRoot)).toEqual([]);
  }, 30_000);

  test('exports every client module only through a client-prefixed subpath', async () => {
    const packageJson = JSON.parse(
      await Bun.file(path.join(repositoryRoot, 'common/package.json')).text(),
    );
    for (const [subpath, target] of Object.entries(packageJson.exports)) {
      if (String(target).startsWith('./client/')) expect(subpath).toStartWith('./client/');
    }
    const clientFiles = [
      ...new Bun.Glob('client/*.ts').scanSync({
        cwd: path.join(repositoryRoot, 'common'),
        onlyFiles: true,
      }),
    ];
    expect(clientFiles).toHaveLength(4);
    for (const clientFile of clientFiles) {
      const moduleName = clientFile.slice('client/'.length, -'.ts'.length);
      expect(packageJson.exports[`./client/${moduleName}`]).toBe(`./${clientFile}`);
    }
    for (const retiredSubpath of [
      './agent-settings',
      './chat-filter-query',
      './client-chat-id',
      './start-selection',
      './workspace-layout',
    ]) {
      expect(packageJson.exports[retiredSubpath]).toBeUndefined();
      expect(await Bun.file(path.join(repositoryRoot, 'common', `${retiredSubpath.slice(2)}.ts`)).exists())
        .toBe(false);
    }
  });

  test('discovers the moved client-shared behavior suites', () => {
    const tests = [
      ...new Bun.Glob('common/**/__tests__/*.{test.js,test.ts}').scanSync({
        cwd: repositoryRoot,
        onlyFiles: true,
      }),
    ];
    expect(tests).toContain('common/client/__tests__/agent-settings.test.ts');
    expect(tests).toContain('common/client/__tests__/chat-filter-query.test.ts');
  });
});
