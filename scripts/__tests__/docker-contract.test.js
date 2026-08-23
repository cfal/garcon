import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '../..');
const provisionedAgents = {
  amp: 'https://ampcode.com/install.sh',
  claude: 'https://claude.ai/install.sh',
  codex: '/app/server-agents/codex/node_modules/.bin/codex',
  cursor: 'https://cursor.com/install',
  factory: 'https://app.factory.ai/cli',
  opencode: 'npm install -g "opencode-ai@${OPENCODE_VERSION}"',
  pi: '/app/server-agents/pi/node_modules/.bin/pi',
};
const persistedPaths = [
  '/home/garcon/.agents',
  '/home/garcon/.claude',
  '/home/garcon/.codex',
  '/home/garcon/.config',
  '/home/garcon/.cursor',
  '/home/garcon/.factory',
  '/home/garcon/.garcon',
  '/home/garcon/.local/share/amp',
  '/home/garcon/.local/share/opencode',
  '/home/garcon/.local/state/opencode',
  '/home/garcon/.pi',
  '/home/garcon/.ssh',
];

let dockerfile;
let composeFile;
let readme;
let dockerignore;
let rootPackage;
let integrationPackage;

beforeAll(async () => {
  [dockerfile, composeFile, readme, dockerignore, rootPackage, integrationPackage] = await Promise.all([
    readFile(path.join(repositoryRoot, 'Dockerfile'), 'utf8'),
    readFile(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'README.md'), 'utf8'),
    readFile(path.join(repositoryRoot, '.dockerignore'), 'utf8'),
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'integration-tests/package.json'), 'utf8').then(JSON.parse),
  ]);
});

describe('Docker contract', () => {
  test('provisions every CLI-backed agent integration', async () => {
    const directories = await readdir(path.join(repositoryRoot, 'server-agents'), { withFileTypes: true });
    const agentIds = directories
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== 'common' && name !== 'interface' && !name.startsWith('direct-'))
      .sort();

    expect(Object.keys(provisionedAgents).sort()).toEqual(agentIds);
    for (const token of Object.values(provisionedAgents)) {
      expect(dockerfile).toContain(token);
    }
  });

  test('keeps coupled CLI versions aligned with the integration tier', () => {
    const openCodeVersion = integrationPackage.devDependencies['opencode-ai'];
    expect(dockerfile).toContain(`ARG OPENCODE_VERSION=${openCodeVersion}`);
    expect(dockerfile).not.toContain('@openai/codex');
    expect(dockerfile).not.toContain('pi-coding-agent');
    expect(dockerfile).not.toContain('opencode-ai@latest');
  });

  test('copies declared patches before installing the workspace', () => {
    expect(Object.keys(rootPackage.patchedDependencies)).not.toHaveLength(0);
    expect(dockerfile.indexOf('COPY patches/ patches/')).toBeGreaterThan(-1);
    expect(dockerfile.indexOf('COPY patches/ patches/')).toBeLessThan(
      dockerfile.indexOf('RUN bun install --frozen-lockfile'),
    );
  });

  test('runs as the configured non-root user', () => {
    expect(dockerfile).toContain('ARG NODE_IMAGE=node:24-bookworm-slim');
    expect(dockerfile).toContain('ARG GARCON_UID=1000');
    expect(dockerfile).toContain('ARG GARCON_GID=1000');
    expect(dockerfile).toContain('GARCON_UID must identify a non-root user');
    expect(dockerfile).toContain('GARCON_GID must identify a non-root group');
    expect(dockerfile.trimEnd()).toMatch(/USER garcon\nCMD \["bun", "server\/main\.ts"\]$/);
  });

  test('persists state without overlaying agent binaries or OpenCode cache', () => {
    const targets = composeFile
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- ') && line.includes(':/home/garcon/'))
      .map((line) => line.slice(line.lastIndexOf(':') + 1).replace(/"$/, ''))
      .sort();

    expect(targets).toEqual([...persistedPaths].sort());
    expect(composeFile).not.toContain('~');
    expect(targets).not.toContain('/home/garcon');
    expect(targets).not.toContain('/home/garcon/.amp');
    expect(targets).not.toContain('/home/garcon/.local/bin');
    expect(targets).not.toContain('/home/garcon/.local/cache/opencode');
    expect(targets).not.toContain('/home/garcon/.local/share/claude');
    expect(targets).not.toContain('/home/garcon/.local/share/cursor-agent');
  });

  test('creates every persistent mountpoint as the runtime user', () => {
    const mkdirIndex = dockerfile.indexOf('mkdir -p \\');
    expect(mkdirIndex).toBeGreaterThan(-1);
    expect(dockerfile.lastIndexOf('USER garcon', mkdirIndex)).toBeGreaterThan(
      dockerfile.lastIndexOf('USER root', mkdirIndex),
    );

    const mkdirBlock = dockerfile.match(/mkdir -p \\\n([\s\S]*?) && \\\n    chmod 700/)?.[1];
    expect(mkdirBlock).toBeDefined();

    const createdPaths = [...mkdirBlock.matchAll(/"\$\{HOME\}([^"\n]+)"/g)].map(
      ([, suffix]) => `/home/garcon${suffix}`,
    );
    for (const target of persistedPaths) {
      expect(createdPaths.some((created) => created === target || created.startsWith(`${target}/`))).toBeTrue();
    }
  });

  test('documents every persistent container path', () => {
    for (const target of persistedPaths) {
      expect(readme).toContain(`\`${target}\``);
    }
  });

  test('excludes local state and dependency trees from the build context', () => {
    const ignoredPaths = new Set(
      dockerignore.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')),
    );
    for (const requiredPath of [
      '**/node_modules',
      '.agents',
      '.amp',
      '.claude',
      '.codex',
      '.config',
      '.cursor',
      '.factory',
      '.garcon',
      '.opencode',
      '.pi',
      '.ssh',
      '.env',
    ]) {
      expect(ignoredPaths).toContain(requiredPath);
    }
  });
});
