import { beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
let executorComposeFile;
let dockerGuide;
let dockerignore;
let dockerPublishWorkflow;
let rootPackage;
let integrationPackage;
let opencodeAgentPackage;
let opencodeSupervisor;

beforeAll(async () => {
  [
    dockerfile,
    composeFile,
    executorComposeFile,
    dockerGuide,
    dockerignore,
    dockerPublishWorkflow,
    rootPackage,
    integrationPackage,
    opencodeAgentPackage,
    opencodeSupervisor,
  ] = await Promise.all([
    readFile(path.join(repositoryRoot, 'Dockerfile'), 'utf8'),
    readFile(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'docker-compose.executor.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'docs/docker.md'), 'utf8'),
    readFile(path.join(repositoryRoot, '.dockerignore'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/docker-publish.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'integration-tests/package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'server-agents/opencode/package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'integration-tests/support/opencode-process-supervisor.ts'), 'utf8'),
  ]);
});

describe('Docker contract', () => {
  test('installs the HTTP CLI independently of container working directory', async () => {
    expect(dockerfile).toContain('COPY cli/ cli/');
    expect(dockerfile).toContain('COPY --chmod=755 docker/garcon-cli /usr/local/bin/garcon-cli');
    expect(dockerfile).not.toContain('ENTRYPOINT');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-docker-cli-'));
    try {
      const fakeBun = path.join(directory, 'bun');
      await writeFile(fakeBun, '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$GARCON_CONFIG_DIR" "$GARCON_RUNTIME" "$@"\nexit 23\n');
      await chmod(fakeBun, 0o755);
      const result = Bun.spawnSync(['sh', path.join(repositoryRoot, 'docker/garcon-cli'),
        '--cwd', '/projects/with spaces', 'literal $value'], {
        cwd: directory,
        env: { PATH: `${directory}:/usr/bin:/bin`, GARCON_CONFIG_DIR: '/private config', GARCON_RUNTIME: 'executor' },
      });
      expect(result.exitCode).toBe(23);
      expect(result.stderr.toString()).toBe('');
      expect(result.stdout.toString().trimEnd().split('\n')).toEqual([
        directory, '/private config', 'executor', '/app/cli/main.ts',
        '--cwd', '/projects/with spaces', 'literal $value',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('provides a standalone worker with independent persistent state and no public listener', () => {
    const controller = Bun.YAML.parse(composeFile);
    const worker = Bun.YAML.parse(executorComposeFile);
    expect(Object.keys(worker.services)).toEqual(['executor']);
    const service = worker.services.executor;
    expect(service.command).toEqual(['bun', 'server/main.ts', 'executor', '--project-base-dir', '/projects']);
    expect(service.image).toBe(controller.services.garcon.image);
    expect(service.build).toEqual(controller.services.garcon.build);
    expect(service.init).toBe(true);
    expect(service.restart).toBe('unless-stopped');
    expect(service.ports).toBeUndefined();
    expect(service.environment).toEqual({ GARCON_RUNTIME: 'executor' });
    expect(service.env_file).toEqual([{ path: '${GARCON_EXECUTOR_ENV_FILE:-./executor.env}', format: 'raw' }]);
    const workerMounts = service.volumes.filter(value => value.includes(':/home/garcon/'));
    expect(workerMounts.map(value => value.slice(value.indexOf(':') + 1)).sort()).toEqual([...persistedPaths].sort());
    for (const mount of workerMounts) {
      const volume = mount.split(':')[0];
      expect(Object.keys(worker.volumes)).toContain(volume);
      expect(Object.keys(controller.volumes)).not.toContain(volume);
    }
    expect(service.volumes.at(-1)).toBe(controller.services.garcon.volumes.at(-1));
    expect(controller.services.garcon.environment.GARCON_PUBLIC_URL).toBe('${GARCON_PUBLIC_URL:-}');
  });

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
    expect(opencodeAgentPackage.dependencies['@opencode-ai/sdk']).toBe(openCodeVersion);
    expect(opencodeSupervisor).toContain(`export const PINNED_OPENCODE_VERSION = '${openCodeVersion}';`);
    expect(dockerfile).not.toContain('@openai/codex');
    expect(dockerfile).not.toContain('pi-coding-agent');
    expect(dockerfile).not.toContain('opencode-ai@latest');
  });

  test('copies declared patches before installing the workspace', () => {
    const patchedDependencies = rootPackage.patchedDependencies ?? {};
    if (Object.keys(patchedDependencies).length === 0) {
      expect(dockerfile).not.toContain('COPY patches/ patches/');
      return;
    }

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
      expect(dockerGuide).toContain(`\`${target}\``);
    }
  });

  test('keeps documented listener credentials outside the checkout', () => {
    const credentialPath = '"$HOME/.config/garcon-onboarding/listener-connection.txt"';
    expect(dockerGuide).toContain('umask 077\n  mkdir -p "$HOME/.config/garcon-onboarding"');
    expect(dockerGuide).toContain(`> ${credentialPath}`);
    expect(dockerGuide).toContain(`--connection-url - < ${credentialPath}`);
    expect(dockerGuide).not.toMatch(/[<>]\s+listener-connection\.txt/);
  });

  test('uses credential-free output in documented enrollment commands', () => {
    const enrollmentBlocks = [...dockerGuide.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map(([, command]) => command)
      .filter((command) => command.includes('garcon-cli executor create'));
    expect(enrollmentBlocks).toHaveLength(2);
    for (const command of enrollmentBlocks) {
      expect(command).not.toContain('--json');
    }
  });

  test('publishes main commits for both Linux architectures', () => {
    expect(dockerPublishWorkflow).toContain('branches:\n      - main');
    expect(dockerPublishWorkflow).not.toContain('pull_request:');
    expect(dockerPublishWorkflow).not.toContain('release:');
    expect(dockerPublishWorkflow).toContain('packages: write');
    expect(dockerPublishWorkflow).toContain('tags: type=sha,format=long,prefix=sha-');
    expect(dockerPublishWorkflow).toContain('platforms: linux/amd64,linux/arm64');
  });

  test('preserves commit images and serializes main promotion', () => {
    expect(dockerPublishWorkflow).toContain('group: docker-publish-sha-${{ github.sha }}');
    expect(dockerPublishWorkflow).toContain('docker buildx imagetools inspect --raw "${commit_image}"');
    expect(dockerPublishWorkflow).toContain("grep -Eiq 'manifest unknown|not found'");
    expect(dockerPublishWorkflow).toMatch(
      /group: docker-publish-main-tag\n\s+cancel-in-progress: false\n\s+queue: max/,
    );
    expect(dockerPublishWorkflow).toContain('needs: publish_sha');
    expect(dockerPublishWorkflow).toContain('"${IMAGE}:main"');
    const workflow = Bun.YAML.parse(dockerPublishWorkflow);
    expect(workflow.jobs.promote_main.needs).toEqual(['publish_sha', 'smoke']);
    expect(workflow.jobs.smoke.needs).toBe('publish_sha');
    expect(workflow.jobs.smoke.steps.at(-1).run).toContain('bun run docker:smoke "${IMAGE}@${DIGEST}"');
    expect(rootPackage.scripts['docker:smoke']).toBe('bun scripts/smoke-docker.js');
  });

  test('supports published images without changing the local Compose default', () => {
    expect(composeFile).toContain('image: "${GARCON_IMAGE:-garcon:local}"');
    expect(dockerGuide).toContain('`ghcr.io/cfal/garcon`');
    expect(dockerGuide).toContain('`sha-<full commit SHA>`');
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
      'executor.env',
    ]) {
      expect(ignoredPaths).toContain(requiredPath);
    }
  });
});
