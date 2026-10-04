import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentAuthLoginCompleteResult,
  AgentAuthLoginLaunchResult,
  AgentAuthLoginStatus,
} from '../../../common/agent-auth.js';
import type { HttpErrorResponse } from '../../../common/http-error.js';
import { executionBackend } from '../../support/execution-backend.js';
import {
  withIntegrationFixture,
  type IntegrationDirectories,
} from '../../support/integration-fixture.js';

const SIGN_IN_URL = 'https://example.test/authorize/synthetic-claude-login';
const INCOMPLETE_CODE_ERROR = 'Paste the complete authorization code, including the # suffix, and submit it again.';
const REJECTED_CODE = 'synthetic-rejected-code#synthetic-suffix';
const ACCEPTED_CODE = 'synthetic-accepted-code#synthetic-suffix';
const ACCOUNT_LABEL = 'synthetic-claude-account@example.test';

interface LoginProcessOwner {
  pid: number;
  parentPid: number;
  home: string;
}

const stateDirectory = (directories: IntegrationDirectories) => join(directories.root, 'claude-auth-fixture');
const binaryPath = (directories: IntegrationDirectories) => join(directories.root, 'claude-auth-stub');

test(`Claude auth HTTP recovers a rejected code on its executor (${executionBackend()})`, async () => {
  await withIntegrationFixture('claude-auth-http-retry', async (fixture) => {
    const { client } = fixture;
    const executorId = client.executorId;
    const stateDir = stateDirectory(fixture.executionDirs);
    const target = { agentId: 'claude', executorId };
    const query = new URLSearchParams({ agent: 'claude', executorId });
    const authUrl = `/api/v1/agents/auth?${query}`;
    const statusUrl = `/api/v1/agents/auth/login?${query}`;
    const status = () => client.get<AgentAuthLoginStatus>(statusUrl);

    expect(await client.get(authUrl)).toMatchObject({ claude: { authenticated: false, canReauth: true } });
    expect(await status()).toEqual({ state: 'idle', running: false });
    const launched = await client.post<AgentAuthLoginLaunchResult>('/api/v1/agents/auth/login', target);
    expect(launched).toMatchObject({
      launched: true,
      alreadyRunning: false,
      deviceAuth: { url: SIGN_IN_URL, needsCode: true },
    });
    expect(launched.sessionId).toBeString();
    expect(launched.sessionId.length).toBeGreaterThan(0);
    const sessionTarget = { ...target, sessionId: launched.sessionId };
    const sessionStatusUrl = `${statusUrl}&session=${encodeURIComponent(launched.sessionId)}`;
    const sessionStatus = () => client.get<AgentAuthLoginStatus>(sessionStatusUrl);
    expect(await sessionStatus()).toMatchObject({
      state: 'running', running: true, sessionId: launched.sessionId, completionPending: false,
    });
    const owner = JSON.parse(await readFile(join(stateDir, 'owner.json'), 'utf8')) as LoginProcessOwner;
    expect(fixture.executionProcessIds.has(owner.parentPid)).toBe(true);
    expect(owner.home).toBe(fixture.executionDirs.home);
    if (executorId !== 'local') {
      expect(owner.parentPid).not.toBe(fixture.garcon.pid);
      expect(await client.get<AgentAuthLoginStatus>('/api/v1/agents/auth/login?agent=claude&executorId=local')).toEqual({ state: 'idle', running: false });
    }

    const complete = (code: string) => client.fetch('/api/v1/agents/auth/login/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...sessionTarget, code }),
    });
    const incomplete = await complete('synthetic-incomplete-code');
    expect(incomplete.status).toBe(400);
    expect(await incomplete.json() as HttpErrorResponse).toMatchObject({
      success: false, errorCode: 'AUTH_LOGIN_CODE_INVALID', retryable: true, error: INCOMPLETE_CODE_ERROR,
    });
    expect(await sessionStatus()).toMatchObject({
      state: 'running', sessionId: launched.sessionId, completionPending: false, retryableError: INCOMPLETE_CODE_ERROR,
      deviceAuth: launched.deviceAuth,
    });
    expect(await readCodes(stateDir)).toEqual([]);
    expect(await client.post('/api/v1/agents/auth/login', target)).toMatchObject({
      launched: false, alreadyRunning: true, sessionId: launched.sessionId,
    });

    const rejected = await complete(REJECTED_CODE);
    expect(rejected.status).toBe(200);
    expect(await rejected.json() as AgentAuthLoginCompleteResult).toEqual({ submitted: true, sessionId: launched.sessionId });
    await waitFor('the rejected code reaches the CLI', () => readCodes(stateDir), codes => codes.length === 1);
    expect(await sessionStatus()).toMatchObject({
      state: 'running', sessionId: launched.sessionId, completionPending: true,
    });
    const duplicate = await complete(ACCEPTED_CODE);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json() as HttpErrorResponse).toMatchObject({
      success: false, errorCode: 'AUTH_LOGIN_SESSION_MISMATCH', retryable: false,
    });
    expect(await readCodes(stateDir)).toEqual([REJECTED_CODE]);

    await writeFile(join(stateDir, 'release-rejection'), 'release');
    await waitFor('the CLI rejection allows a retry', sessionStatus, result =>
      result.state === 'running' && !result.completionPending && result.retryableError === INCOMPLETE_CODE_ERROR);
    expect(await status()).toMatchObject({
      state: 'running', sessionId: launched.sessionId, completionPending: false, retryableError: INCOMPLETE_CODE_ERROR,
      deviceAuth: launched.deviceAuth,
    });

    const accepted = await complete(ACCEPTED_CODE);
    expect(accepted.status).toBe(200);
    expect(await accepted.json() as AgentAuthLoginCompleteResult).toEqual({ submitted: true, sessionId: launched.sessionId });
    await waitFor('the accepted code reaches the CLI', () => readCodes(stateDir), codes => codes.length === 2);
    expect(await sessionStatus()).toMatchObject({
      state: 'running', sessionId: launched.sessionId, completionPending: true,
    });
    expect(await status()).toMatchObject({ completionPending: true });
    expect(await sessionStatus()).not.toHaveProperty('retryableError');

    await writeFile(join(stateDir, 'release-success'), 'release');
    expect(await waitFor('successful sign-in', sessionStatus, result => result.state === 'succeeded')).toEqual({
      state: 'succeeded', running: false, sessionId: launched.sessionId,
    });
    expect(await status()).toEqual({ state: 'idle', running: false });
    expect(await client.get(authUrl)).toMatchObject({
      claude: { authenticated: true, canReauth: true, label: ACCOUNT_LABEL },
    });
    expect(await readCodes(stateDir)).toEqual([REJECTED_CODE, ACCEPTED_CODE]);
    expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(0);
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(0);
    expect(fixture.fakeProviders.openAiResponses.requests()).toHaveLength(0);
  }, {
    resolveServerEnvironment: directories => ({
      CLAUDE_BINARY: binaryPath(directories),
      CLAUDE_CONFIG_DIR: join(directories.home, '.claude-isolated'),
    }),
    async prepareWorkspace(directories) {
      const stateDir = stateDirectory(directories);
      await mkdir(stateDir, { recursive: true });
      await writeFile(binaryPath(directories), authCliSource(stateDir));
      await chmod(binaryPath(directories), 0o755);
    },
    async afterGarconStop(directories) {
      const owner = await readFile(join(stateDirectory(directories), 'owner.json'), 'utf8').then(
        text => JSON.parse(text) as LoginProcessOwner,
        () => null,
      );
      if (owner) await waitFor('owned login process cleanup', async () => processRunning(owner.pid), running => !running);
    },
  });
}, 60_000);

async function readCodes(stateDir: string): Promise<string[]> {
  const contents = await readFile(join(stateDir, 'codes.jsonl'), 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  return contents.split('\n').filter(Boolean).map(line => JSON.parse(line) as string);
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor<T>(description: string, read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (matches(last)) return last;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(last)}`);
}

function authCliSource(stateDir: string): string {
  return String.raw`#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const stateDir = ${JSON.stringify(stateDir)};
const authenticatedPath = join(stateDir, 'authenticated');
const [command, subcommand] = process.argv.slice(2);
if (command === '--version') {
  console.log('2.1.285 (Claude Code)');
  process.exit(0);
}
if (command !== 'auth') throw new Error('The auth fixture cannot run model commands');
if (subcommand === 'status') {
  const loggedIn = existsSync(authenticatedPath);
  console.log(JSON.stringify({ loggedIn, authMethod: 'claude.ai', email: ${JSON.stringify(ACCOUNT_LABEL)} }));
  process.exit(loggedIn ? 0 : 1);
}
if (subcommand !== 'login') throw new Error('Unsupported auth fixture subcommand');
writeFileSync(join(stateDir, 'owner.json'), JSON.stringify({ pid: process.pid, parentPid: process.ppid, home: process.env.HOME }));
console.log(${JSON.stringify(SIGN_IN_URL)});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  appendFileSync(join(stateDir, 'codes.jsonl'), JSON.stringify(line) + '\n');
  if (line === ${JSON.stringify(REJECTED_CODE)}) {
    await release('release-rejection');
    console.error('Invalid code. Please make sure the full code was copied.');
    continue;
  }
  if (line === ${JSON.stringify(ACCEPTED_CODE)}) {
    await release('release-success');
    writeFileSync(authenticatedPath, 'synthetic-authenticated');
    console.log('Login succeeded');
    process.exit(0);
  }
  throw new Error('Unexpected synthetic authorization code');
}
process.exit(1);

async function release(name) {
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(stateDir, name))) {
    if (Date.now() >= deadline) throw new Error('Auth fixture release timed out');
    await Bun.sleep(10);
  }
}
`;
}
