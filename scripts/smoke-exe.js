#!/usr/bin/env bun

import path from 'node:path';

const SERVER_READY_PATTERN = /Started at (http:\/\/[^\s]+)/;
const STARTUP_TIMEOUT_MS = 15000;
const SHUTDOWN_TIMEOUT_MS = 5000;
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

  const child = Bun.spawn({
    cmd: [executablePath, '--port', '0', '--bind-address', '127.0.0.1'],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let started;
  try {
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
  } finally {
    await stopProcess(child);
  }

  console.log(`Smoke check passed for ${executablePath}`);
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
