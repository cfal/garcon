#!/usr/bin/env bun

import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

const SERVER_READY_PATTERN = /Started at (http:\/\/[^\s]+)/;
const STARTUP_TIMEOUT_MS = 45000;
const SHUTDOWN_TIMEOUT_MS = 15000;
const SMOKE_CHAT_ID = '1767225600000000';
const executableNamesByHost = {
  'linux-x64': 'garcon-linux-x64',
  'darwin-arm64': 'garcon-darwin-arm64',
  'windows-x64': 'garcon-windows-x64.exe',
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerUrl(processHandle) {
  let output = '';
  const decoder = new TextDecoder();
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
  return { url, output };
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

async function waitForTranscriptResult(url, token, chatId) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/v1/chats/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: token }),
    });
    lastStatus = response.status;
    if (response.ok) {
      const body = await response.json();
      if (body.results?.some((result) => result.chatId === chatId)) return;
    }
    await delay(50);
  }
  throw new Error(`Transcript search did not return ${chatId}; last status was ${lastStatus}.`);
}

function getHostTarget() {
  return `${process.platform}-${process.arch}`;
}

function parseExecutablePath(argv) {
  const explicitPath = argv.find((argument) => argument.startsWith('--path='));
  if (explicitPath) {
    return path.resolve(process.cwd(), explicitPath.slice('--path='.length));
  }

  const explicitTarget = argv.find((argument) => argument.startsWith('--target='));
  if (explicitTarget) {
    const target = explicitTarget.slice('--target='.length).trim();
    const executableName = executableNamesByHost[target];
    if (!executableName) {
      const supportedTargets = Object.keys(executableNamesByHost).join(', ');
      throw new Error(`Unsupported smoke target "${target}". Supported targets: ${supportedTargets}.`);
    }
    return path.resolve(process.cwd(), 'dist', executableName);
  }

  const executableName = executableNamesByHost[getHostTarget()];
  if (!executableName) {
    const supportedTargets = Object.keys(executableNamesByHost).join(', ');
    throw new Error(`Unsupported host target "${getHostTarget()}". Supported targets: ${supportedTargets}.`);
  }

  return path.resolve(process.cwd(), 'dist', executableName);
}

async function run() {
  const executablePath = parseExecutablePath(Bun.argv.slice(2));
  if (!(await Bun.file(executablePath).exists())) {
    throw new Error(`Missing executable at ${executablePath}. Run "bun run build-exe:compile" first.`);
  }

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-exe-smoke-'));
  const spawnServer = () => Bun.spawn({
    cmd: [
      executablePath,
      '--port',
      '0',
      '--bind-address',
      '127.0.0.1',
      '--disable-auth',
      '--workspace-dir',
      workspaceDir,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let child = spawnServer();
  try {
    let started = await waitForServerUrl(child);

    if (await Bun.file(path.join(workspaceDir, 'chat-search-v3.sqlite')).exists()) {
      throw new Error('Default-off executable unexpectedly created a transcript search database.');
    }
    await stopProcess(child);

    await writeFile(
      path.join(workspaceDir, 'project-settings.json'),
      JSON.stringify({ features: { transcriptSearch: { enabled: true } } }),
    );
    const transcriptPath = path.join(workspaceDir, 'smoke-claude.jsonl');
    await writeFile(transcriptPath, JSON.stringify({
      sessionId: 'smoke-session',
      uuid: 'smoke-user-message',
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'embeddedworkertoken' },
    }));
    await writeFile(path.join(workspaceDir, 'chats.json'), JSON.stringify({
      version: 2,
      sessions: {
        [SMOKE_CHAT_ID]: {
          agentId: 'claude',
          agentSessionId: 'smoke-session',
          nativePath: transcriptPath,
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

    if (!(await Bun.file(path.join(workspaceDir, 'chat-search-v3.sqlite')).exists())) {
      throw new Error('Enabled executable did not start the embedded transcript search worker.');
    }

    await waitForTranscriptResult(started.url, 'embeddedworkertoken', SMOKE_CHAT_ID);
    await stopProcess(child);

    child = spawnServer();
    started = await waitForServerUrl(child);
    await waitForTranscriptResult(started.url, 'embeddedworkertoken', SMOKE_CHAT_ID);
  } finally {
    await stopProcess(child);
    await rm(workspaceDir, { recursive: true, force: true });
  }

  console.log(`Smoke check passed for ${executablePath}`);
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
