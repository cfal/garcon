#!/usr/bin/env bun

import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

const SERVER_READY_PATTERN = /Started at (http:\/\/[^\s]+)/;
const STARTUP_TIMEOUT_MS = 45000;
const SHUTDOWN_TIMEOUT_MS = 15000;
const SMOKE_CHAT_ID = '1767225600000000';
const EXPECTED_BUNDLED_PREAMBLES = [
  ['5c3a9b1c-f675-4bca-9a8f-239cd4c38b87', 'Garcon: Chat identity'],
  ['36edcbed-0d64-4d8e-b3df-3f1b1f8602b9', 'Garcon: Inter-chat messages'],
  ['3462ad70-c497-4009-b11a-79474dfb292a', 'Garcon: Delegated agents'],
  ['d5597052-6f66-4564-b9fa-bd8660725c47', 'Garcon: Scheduled prompts'],
  ['9b0a6bc3-92fc-4472-9cb9-8481590111f3', 'Garcon: Tickets'],
  ['5eb1abe3-188b-407f-aa9d-4ca4ed065c66', 'Garcon: Captain'],
];
const SMOKE_ISOLATION_ENV_KEYS = new Set([
  'GARCON_CONFIG_DIR',
  'GARCON_RUNTIME',
  'GARCON_CLI_RUNTIME',
  'GARCON_WORKSPACE_DIR',
  'GARCON_WORKSPACE',
  'GARCON_PORT',
  'GARCON_BIND_ADDRESS',
  'GARCON_PROJECT_BASE_DIR',
  'GARCON_DISABLE_AUTH',
  'GARCON_AGENT_EXECUTION_NODE_CONFIG',
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

async function authenticatedFetch(url, credentials) {
  const unauthenticated = await fetch(`${url}/api/v1/preambles`);
  if (unauthenticated.status !== 401) throw new Error('Smoke server must reject unauthenticated API requests');
  const response = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
  });
  const login = await response.json();
  if (!response.ok || typeof login.token !== 'string') throw new Error('Smoke server authentication failed');
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${login.token}`);
    return fetch(input, { ...init, headers });
  };
}

async function assertBundledPreambles(url, apiFetch) {
  const response = await apiFetch(`${url}/api/v1/preambles`);
  if (!response.ok) {
    throw new Error(`Expected GET /api/v1/preambles to succeed, received ${response.status}`);
  }
  const snapshot = await response.json();
  const installed = snapshot.preambles?.map(({ id, title, enabled }) => [id, title, enabled]);
  const expected = EXPECTED_BUNDLED_PREAMBLES.map(([id, title]) => [id, title, false]);
  if (snapshot.revision !== 1 || JSON.stringify(installed) !== JSON.stringify(expected)) {
    throw new Error(`Executable did not install the bundled preamble catalog: ${JSON.stringify(snapshot)}`);
  }
}

async function assertCompiledExecutionNode(url, executablePath, workspaceDir, apiFetch) {
  const response = await apiFetch(`${url}/api/v1/execution-nodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'Compiled Worker', direction: 'node-connects', allowInsecureDevelopment: true,
    }),
  });
  if (!response.ok) throw new Error(`Unable to configure compiled worker: ${response.status}`);
  const configured = await response.json();
  const connection = new URL(configured.connectionUrl);
  connection.protocol = 'ws:';
  connection.host = new URL(url).host;
  connection.hostname = '127.0.0.1';
  const worker = Bun.spawn({
    cmd: [
      executablePath, 'execution-node', '--connect', connection.href,
      '--allow-insecure-development', '--config-dir', path.join(workspaceDir, 'worker'),
      '--project-base-dir', workspaceDir,
    ],
    env: isolatedServerEnvironment(),
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const workerErrors = new Response(worker.stderr).text();
  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (true) {
      if (worker.exitCode !== null) throw new Error(`Compiled worker exited with code ${worker.exitCode}: ${await workerErrors}`);
      const snapshot = await apiFetch(`${url}/api/v1/execution-nodes`).then((result) => result.json());
      if (snapshot.nodes?.some((node) => node.id === configured.id && node.availability === 'ready')) break;
      if (Date.now() >= deadline) throw new Error('Compiled worker did not become ready');
      await delay(50);
    }
    const inspectionUrl = new URL('/api/v1/chats/validate-start', url);
    inspectionUrl.searchParams.set('nodeId', configured.id);
    inspectionUrl.searchParams.set('path', workspaceDir);
    const inspection = await apiFetch(inspectionUrl);
    if (!inspection.ok || !(await inspection.json()).valid) {
      throw new Error('Compiled worker project inspection failed');
    }
    const terminalsUrl = `${url}/api/v1/terminals`;
    const inventory = await apiFetch(`${terminalsUrl}?nodeId=${configured.id}`).then(result => result.json());
    const created = await apiFetch(terminalsUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: configured.id, expectedTerminalRuntimeId: inventory.terminalRuntimeId,
        requestId: 'compiled-terminal', requestedInitialWorkingDirectory: workspaceDir }),
    });
    const terminal = await created.json();
    if (!created.ok || !terminal.terminal?.terminalId) throw new Error(`Compiled worker PTY failed: ${JSON.stringify(terminal)}`);
    const removed = await apiFetch(terminalsUrl, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminalId: terminal.terminal.terminalId, requestId: 'compiled-terminal-stop' }),
    });
    if (!removed.ok) throw new Error('Compiled worker PTY cleanup failed');
  } finally {
    await stopProcess(worker);
  }
}

async function waitForTranscriptResult(url, token, chatId, getServerOutput, apiFetch) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastStatus = 0;
  let lastBody = '';
  while (Date.now() < deadline) {
    const response = await apiFetch(`${url}/api/v1/chats/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: token }),
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
  const cliHelp = Bun.spawnSync([executablePaths.cli, '--help']);
  if (cliHelp.exitCode !== 0 || !cliHelp.stdout.toString().startsWith('Usage:\n  garcon-cli')) {
    throw new Error(`CLI executable help smoke check failed for ${executablePaths.cli}.`);
  }

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-exe-smoke-'));
  const configDir = path.join(workspaceDir, 'config');
  const credentials = { username: 'smoke', password: crypto.randomUUID() };
  await mkdir(configDir, { mode: 0o700 });
  await writeFile(path.join(configDir, 'auth.json'), JSON.stringify({
    username: credentials.username,
    passwordHash: await Bun.password.hash(credentials.password, { algorithm: 'bcrypt', cost: 12 }),
  }), { mode: 0o600 });
  const spawnServer = () => Bun.spawn({
    cmd: [
      executablePath,
      '--port',
      '0',
      '--bind-address',
      '0.0.0.0',
      '--config-dir',
      configDir,
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
    const apiFetch = await authenticatedFetch(started.url, credentials);
    const searchDatabase = path.join(workspaceDir, 'transcript-search', 'index.sqlite');

    if (await Bun.file(searchDatabase).exists()) {
      throw new Error('Default-off executable unexpectedly created a transcript search database.');
    }
    await assertBundledPreambles(started.url, apiFetch);
    await assertCompiledExecutionNode(started.url, executablePath, workspaceDir, apiFetch);
    await stopProcess(child);

    await writeFile(
      path.join(workspaceDir, 'project-settings.json'),
      JSON.stringify({ features: { transcriptSearch: { enabled: true } } }),
    );
    const transcriptPath = path.join(workspaceDir, 'smoke-session.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      sessionId: 'smoke-session',
      uuid: 'smoke-user-message',
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'embeddedworkertoken' },
    })}\n`);
    await writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 5,
      sessions: {
        [SMOKE_CHAT_ID]: {
          agentId: 'claude',
          nativeSession: {
            ownerId: 'claude',
            schemaVersion: 1,
            value: {
              path: transcriptPath,
              agentSessionId: 'smoke-session',
            },
          },
          agentOwnershipEpoch: 'smoke-ownership-epoch',
          carryOverSegments: [],
          nativeSeedReceipt: null,
          carryOverMigrationQuarantine: null,
          agentSettingsById: {
            claude: { ownerId: 'claude', schemaVersion: 1, values: {} },
          },
          tags: [],
          agentSessionId: 'smoke-session',
          projectPath: workspaceDir,
          model: 'fable',
        },
      },
    }));
    child = spawnServer();
    started = await waitForServerUrl(child);

    const rootResponse = await fetch(`${started.url}/`);
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

    const assetResponse = await fetch(`${started.url}${appAssetMatch[0]}`);
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
      'embeddedworkertoken',
      SMOKE_CHAT_ID,
      started.getOutput,
      apiFetch,
    );
    await stopProcess(child);

    child = spawnServer();
    started = await waitForServerUrl(child);
    await waitForTranscriptResult(
      started.url,
      'embeddedworkertoken',
      SMOKE_CHAT_ID,
      started.getOutput,
      apiFetch,
    );
  } finally {
    await stopProcess(child);
    await rm(workspaceDir, { recursive: true, force: true });
  }

  console.log(`Smoke check passed for ${executablePath} and ${executablePaths.cli}`);
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
