#!/usr/bin/env bun

import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { smokeSystemdHelper } from './smoke-systemd-helper.js';
import { seedSmokeAccount, seedSmokeTranscript, SMOKE_CHAT_ID, SMOKE_SEARCH_TOKEN } from './smoke-exe-fixture.js';
import { SYSTEMD_HELPER_FLAG } from '../server/execution-node/systemd/contracts.js';

const SERVER_READY_PATTERN = /Started at (http:\/\/[^\s]+)/;
const STARTUP_TIMEOUT_MS = 45000;
const SHUTDOWN_TIMEOUT_MS = 15000;
const SMOKE_ISOLATION_ENV_KEYS = new Set([
  'GARCON_CONFIG_DIR',
  'GARCON_WORKSPACE_DIR',
  'GARCON_WORKSPACE',
  'GARCON_PORT',
  'GARCON_BIND_ADDRESS',
  'GARCON_PROJECT_BASE_DIR',
  'GARCON_DISABLE_AUTH',
  'DISABLE_AUTH',
  'PI_PACKAGE_DIR',
  'GARCON_EMBEDDED_PI_PACKAGE_DIR',
]);
const executableNamesByHost = {
  'linux-x64': { server: 'garcon-linux-x64', cli: 'garcon-cli-linux-x64' },
  'darwin-arm64': { server: 'garcon-darwin-arm64', cli: 'garcon-cli-darwin-arm64' },
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isolatedServerEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (SMOKE_ISOLATION_ENV_KEYS.has(key.toUpperCase())) delete environment[key];
  }
  return environment;
}

async function waitForServerUrl(processHandle) {
  let output = '';
  let resolveStarted;
  let rejectStarted;
  const startedPromise = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });

  const scan = (textChunk) => {
    output += textChunk;
    const match = output.match(SERVER_READY_PATTERN);
    if (match) {
      resolveStarted(match[1]);
    }
  };

  const pump = async (stream) => {
    const reader = stream?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        scan(decoder.decode(value, { stream: true }));
      }
      const trailing = decoder.decode();
      if (trailing) scan(trailing);
    } catch (error) {
      rejectStarted(error);
    } finally {
      reader.releaseLock();
    }
  };

  const stdoutPump = pump(processHandle.stdout);
  const stderrPump = pump(processHandle.stderr);

  const timeoutPromise = delay(STARTUP_TIMEOUT_MS).then(() => {
    throw new Error(`Timed out waiting for server startup. Captured output:\n${output}`);
  });

  const exitPromise = processHandle.exited.then((code) => {
    throw new Error(`Executable exited early with code ${code}. Captured output:\n${output}`);
  });

  const url = await Promise.race([startedPromise, timeoutPromise, exitPromise]);
  await Promise.race([stdoutPump, delay(50)]);
  await Promise.race([stderrPump, delay(50)]);
  return { url, getOutput: () => output };
}

async function stopProcess(processHandle) {
  processHandle.kill('SIGTERM');
  await Promise.race([
    processHandle.exited,
    delay(SHUTDOWN_TIMEOUT_MS).then(() => {
      processHandle.kill('SIGKILL');
      return processHandle.exited;
    }),
  ]);
}

async function authenticateSmoke(url, account) {
  const anonymous = await fetch(`${url}/api/v1/chats`, { signal: AbortSignal.timeout(5_000) });
  if (anonymous.status !== 401) throw new Error('Executable exposed unauthenticated chat access.');
  const response = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Executable login failed with HTTP ${response.status}.`);
  const { token } = await response.json();
  if (typeof token !== 'string' || !token) throw new Error('Executable login returned no token.');
  return { Authorization: `Bearer ${token}` };
}

export async function waitForTranscriptResult(url, token, chatId, getServerOutput, authorization) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastStatus = 0;
  let lastBody = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/v1/chats/search`, {
        method: 'POST',
        headers: { ...authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ query: token }),
        signal: AbortSignal.timeout(5_000),
      });
      lastStatus = response.status;
      lastBody = await response.text();
      if (response.ok) {
        let body = null;
        try {
          body = JSON.parse(lastBody);
        } catch {
          // The final diagnostic retains a malformed response body.
        }
        if (body?.results?.some((result) => result.chatId === chatId)) return;
      }
    } catch (error) {
      lastStatus = 0;
      lastBody = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await delay(50);
  }
  throw new Error(
    `Transcript search did not return ${chatId}; last status was ${lastStatus}; `
      + `last body was ${lastBody || '<empty>'}. Captured output:\n${getServerOutput()}`,
  );
}

function getHostTarget() {
  return `${process.platform}-${process.arch}`;
}

function parseExecutablePaths(argv) {
  const explicitPath = argv.find((argument) => argument.startsWith('--path='));
  const explicitCliPath = argv.find((argument) => argument.startsWith('--cli-path='));
  if (explicitPath) {
    const names = executableNamesByHost[getHostTarget()];
    if (!names && !explicitCliPath) {
      throw new Error(`--cli-path is required on unsupported host ${getHostTarget()}.`);
    }
    const server = path.resolve(process.cwd(), explicitPath.slice('--path='.length));
    const cli = explicitCliPath
      ? path.resolve(process.cwd(), explicitCliPath.slice('--cli-path='.length))
      : path.resolve(path.dirname(server), names.cli);
    return { server, cli };
  }

  const explicitTarget = argv.find((argument) => argument.startsWith('--target='));
  if (explicitTarget) {
    const target = explicitTarget.slice('--target='.length).trim();
    const names = executableNamesByHost[target];
    if (!names) {
      const supportedTargets = Object.keys(executableNamesByHost).join(', ');
      throw new Error(`Unsupported smoke target "${target}". Supported targets: ${supportedTargets}.`);
    }
    return {
      server: path.resolve(process.cwd(), 'dist', names.server),
      cli: path.resolve(process.cwd(), 'dist', names.cli),
    };
  }

  const names = executableNamesByHost[getHostTarget()];
  if (!names) {
    const supportedTargets = Object.keys(executableNamesByHost).join(', ');
    throw new Error(`Unsupported host target "${getHostTarget()}". Supported targets: ${supportedTargets}.`);
  }

  return {
    server: path.resolve(process.cwd(), 'dist', names.server),
    cli: path.resolve(process.cwd(), 'dist', names.cli),
  };
}

async function run() {
  const executablePaths = parseExecutablePaths(Bun.argv.slice(2));
  const executablePath = executablePaths.server;
  if (!(await Bun.file(executablePath).exists())) {
    throw new Error(`Missing executable at ${executablePath}. Run "bun run build-exe:compile" first.`);
  }
  if (!(await Bun.file(executablePaths.cli).exists())) {
    throw new Error(`Missing CLI executable at ${executablePaths.cli}. Run "bun run build-exe:compile" first.`);
  }
  await smokeSystemdHelper([executablePath, SYSTEMD_HELPER_FLAG]);
  const cliHelp = Bun.spawnSync([executablePaths.cli, '--help']);
  if (cliHelp.exitCode !== 0 || !cliHelp.stdout.toString().startsWith('Usage:\n  garcon-cli')) {
    throw new Error(`CLI executable help smoke check failed for ${executablePaths.cli}.`);
  }

  const directory = await mkdtemp(path.join(os.homedir(), 'garcon-exe-smoke-'));
  const workspaceDir = path.join(directory, 'workspace');
  const configDirectory = path.join(directory, 'config');
  await Promise.all([workspaceDir, configDirectory].map((target) => mkdir(target, { mode: 0o700 })));
  const account = await seedSmokeAccount(configDirectory);
  const spawnServer = () => Bun.spawn({
    cmd: [
      executablePath,
      '--port',
      '0',
      '--bind-address',
      '0.0.0.0',
      '--config-dir',
      configDirectory,
      '--workspace-dir',
      workspaceDir,
      '--project-base-dir',
      workspaceDir,
    ],
    env: isolatedServerEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let child = spawnServer();
  try {
    let started = await waitForServerUrl(child);
    await authenticateSmoke(started.url, account);
    const searchDatabase = path.join(workspaceDir, 'transcript-search', 'index.sqlite');

    if (await Bun.file(searchDatabase).exists()) {
      throw new Error('Default-off executable unexpectedly created a transcript search database.');
    }
    await stopProcess(child);

    await seedSmokeTranscript(workspaceDir);
    child = spawnServer();
    started = await waitForServerUrl(child);
    let authorization = await authenticateSmoke(started.url, account);

    const rootResponse = await fetch(`${started.url}/`, { headers: authorization, signal: AbortSignal.timeout(5_000) });
    if (!rootResponse.ok) {
      throw new Error(`Expected GET / to succeed, received ${rootResponse.status}`);
    }
    const contentType = rootResponse.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      throw new Error(`Expected GET / to return text/html, got "${contentType || 'none'}"`);
    }

    const html = await rootResponse.text();
    const appAssetMatch = html.match(/\/_app\/[^"'\s>]+/);
    if (!appAssetMatch) {
      throw new Error('Could not find a /_app/ asset URL in index.html response.');
    }

    const assetResponse = await fetch(`${started.url}${appAssetMatch[0]}`, { headers: authorization, signal: AbortSignal.timeout(5_000) });
    if (!assetResponse.ok) {
      throw new Error(`Expected GET ${appAssetMatch[0]} to succeed, received ${assetResponse.status}`);
    }

    if (!(await Bun.file(searchDatabase).exists())) {
      throw new Error(
        `Enabled executable did not create the shared transcript search index. Captured output:\n${started.getOutput()}`,
      );
    }

    await waitForTranscriptResult(
      started.url,
      SMOKE_SEARCH_TOKEN,
      SMOKE_CHAT_ID,
      started.getOutput,
      authorization,
    );
    await stopProcess(child);

    child = spawnServer();
    started = await waitForServerUrl(child);
    authorization = await authenticateSmoke(started.url, account);
    await waitForTranscriptResult(
      started.url,
      SMOKE_SEARCH_TOKEN,
      SMOKE_CHAT_ID,
      started.getOutput,
      authorization,
    );
  } finally {
    await stopProcess(child);
    await rm(directory, { recursive: true, force: true });
  }

  console.log(`Smoke check passed for ${executablePath} and ${executablePaths.cli}`);
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
