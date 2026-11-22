import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  parseAgentCliUpdatesResponse,
  parseAgentCliUpdateStatus,
  type AgentCliUpdatesResponse,
  type AgentCliUpdateStatus,
} from '../../../common/agent-cli-update.js';
import type { HttpErrorResponse } from '../../../common/http-error.js';
import { executionBackend } from '../../support/execution-backend.js';
import {
  withIntegrationFixture,
  type IntegrationDirectories,
} from '../../support/integration-fixture.js';

const PACKAGE = '@anthropic-ai/claude-code';
const INSTALLED_VERSION = '2.1.285';
const LATEST_VERSION = '2.1.300';

interface InstallerRun {
  pid: number;
  parentPid: number;
  args: string;
}

const toolsDirectory = (directories: IntegrationDirectories) => join(directories.root, 'cli-update-tools');
const npmPrefix = (directories: IntegrationDirectories) => join(directories.root, 'cli-update-npm-prefix');
const packageDirectory = (directories: IntegrationDirectories) => join(npmPrefix(directories), 'lib', 'node_modules', PACKAGE);
const claudeLauncher = (directories: IntegrationDirectories) => join(npmPrefix(directories), 'bin', 'claude');
const codexLauncher = (directories: IntegrationDirectories) => join(toolsDirectory(directories), 'custom-codex');
const installerLog = (directories: IntegrationDirectories) => join(directories.root, 'cli-update-npm.jsonl');

test(`Claude Code updates through its npm installer on its executor (${executionBackend()})`, async () => {
  await withIntegrationFixture('agent-cli-updates', async (fixture) => {
    const { client } = fixture;
    const executorId = client.executorId;
    const statusesUrl = `/api/v1/agents/cli-updates?executorId=${encodeURIComponent(executorId)}`;
    const statuses = async (refresh = false) => {
      const response = parseAgentCliUpdatesResponse(
        await client.get<AgentCliUpdatesResponse>(`${statusesUrl}${refresh ? '&refresh=1' : ''}`),
      );
      if (!response) throw new Error('Invalid CLI update statuses');
      return response;
    };

    const before = await statuses(true);
    expect(before.failures).toEqual({});
    expect(before.statuses.claude).toMatchObject({
      installMethod: 'npm',
      installPath: join(packageDirectory(fixture.executionDirs), 'cli.sh'),
      currentVersion: INSTALLED_VERSION,
      latestVersion: LATEST_VERSION,
      advisory: 'behind-latest',
      canUpdate: true,
      run: { state: 'idle' },
    });
    expect(before.statuses.claude!.updateCommand)
      .toBe(`npm install -g --prefix ${npmPrefix(fixture.executionDirs)} --allow-scripts=${PACKAGE} ${PACKAGE}@latest`);
    expect(before.statuses.codex).toMatchObject({
      installMethod: 'unmanaged',
      installPath: codexLauncher(fixture.executionDirs),
      currentVersion: '0.171.0',
      canUpdate: false,
    });

    const unmanaged = await client.fetch('/api/v1/agents/cli-updates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'codex', executorId }),
    });
    expect(unmanaged.status).toBe(422);
    expect(await unmanaged.json() as HttpErrorResponse).toMatchObject({ success: false, errorCode: 'OPERATION_UNSUPPORTED' });

    const started = parseAgentCliUpdateStatus(await client.post<AgentCliUpdateStatus>('/api/v1/agents/cli-updates', {
      agentId: 'claude', executorId,
    }));
    expect(started?.run.state).toBe('running');
    const repeated = parseAgentCliUpdateStatus(await client.post<AgentCliUpdateStatus>('/api/v1/agents/cli-updates', {
      agentId: 'claude', executorId,
    }));
    expect(repeated?.run.startedAt).toBe(started!.run.startedAt);

    const settled = await waitFor('the update to settle', statuses, (response) => response.statuses.claude?.run.state !== 'running');
    expect(settled.statuses.claude).toMatchObject({
      currentVersion: LATEST_VERSION,
      advisory: 'current',
      run: { state: 'succeeded', message: `Updated Claude Code to ${LATEST_VERSION}. Running chats keep the previous version; new sessions use the update.` },
    });

    const installs = (await readInstallerRuns(fixture.executionDirs)).filter((run) => run.args.startsWith('install'));
    expect(installs).toHaveLength(1);
    expect(installs[0]!.args)
      .toBe(`install -g --prefix ${npmPrefix(fixture.executionDirs)} --allow-scripts=${PACKAGE} ${PACKAGE}@latest`);
    expect(fixture.executionProcessIds.has(installs[0]!.parentPid)).toBe(true);
    if (executorId !== 'local') {
      expect(installs[0]!.parentPid).not.toBe(fixture.garcon.pid);
      const local = parseAgentCliUpdatesResponse(await client.get('/api/v1/agents/cli-updates?executorId=local'));
      expect(local?.statuses.claude?.run.state).toBe('idle');
    }
  }, {
    resolveServerEnvironment: (directories) => ({
      CLAUDE_BINARY: claudeLauncher(directories),
      CLAUDE_CONFIG_DIR: join(directories.home, '.claude-isolated'),
      GARCON_CODEX_CLI: codexLauncher(directories),
      PATH: `${toolsDirectory(directories)}:${process.env.PATH ?? ''}`,
    }),
    async prepareWorkspace(directories) {
      const packageDir = packageDirectory(directories);
      await writeExecutable(join(packageDir, 'cli.sh'), fakeClaudeSource(join(packageDir, 'VERSION')));
      await writeFile(join(packageDir, 'VERSION'), INSTALLED_VERSION);
      await mkdir(dirname(claudeLauncher(directories)), { recursive: true });
      await symlink(join(packageDir, 'cli.sh'), claudeLauncher(directories));
      await writeExecutable(codexLauncher(directories), '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\necho "codex-cli 0.171.0"\n');
      await writeExecutable(join(toolsDirectory(directories), 'npm'), fakeNpmSource(directories));
    },
  });
}, 60_000);

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  await chmod(path, 0o755);
}

function fakeClaudeSource(versionFile: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "$(cat ${JSON.stringify(versionFile)}) (Claude Code)"
  exit 0
fi
echo "The CLI update fixture cannot run model commands" >&2
exit 2
`;
}

// Answers `npm view` with the latest version and installs it on `npm install`,
// recording each run with the process that started it.
function fakeNpmSource(directories: IntegrationDirectories): string {
  return `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(installerLog(directories))}, JSON.stringify({ pid: process.pid, parentPid: process.ppid, args: args.join(' ') }) + '\\n');
if (args[0] === 'view') {
  console.log(JSON.stringify(${JSON.stringify(LATEST_VERSION)}));
} else if (args[0] === 'install') {
  console.log('added 1 package in 1s');
  writeFileSync(${JSON.stringify(join(packageDirectory(directories), 'VERSION'))}, ${JSON.stringify(LATEST_VERSION)});
} else {
  console.error('Unsupported npm fixture command');
  process.exit(1);
}
`;
}

async function readInstallerRuns(directories: IntegrationDirectories): Promise<InstallerRun[]> {
  const contents = await readFile(installerLog(directories), 'utf8');
  return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line) as InstallerRun);
}

async function waitFor<T>(description: string, read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (matches(last)) return last;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(last)}`);
}
