import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  buildPiCliEnv,
  buildPiPrompt,
  PI_PLAN_PREFIX,
  requireExplicitPiModel,
  runSingleQuery,
} from '../pi-cli.js';
import { testPiConfig } from './test-fixtures.js';

// Covers the one-shot surfaces that survive the RPC switch: single-query runs (chat titles
// and other utility prompts), spawn environment hygiene, and prompt construction. The
// long-lived turn runtime is covered by pi-rpc-runtime.test.ts.

const originalSpawn = Bun.spawn;
const originalEnv = { ...process.env };
let tempRoot;

function createCompletedProc(stdoutText = 'pi response') {
  const encoder = new TextEncoder();
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stdoutText));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    stdin: { write() {}, end() {} },
    exited: Promise.resolve(0),
  };
}

function createFailedProc(exitCode, stderrText = 'boom') {
  const encoder = new TextEncoder();
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stderrText));
        controller.close();
      },
    }),
    stdin: { write() {}, end() {} },
    exited: Promise.resolve(exitCode),
  };
}

describe('Pi single-query and spawn helpers', () => {
  let spawnMock;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-pi-provider-'));
    await fs.mkdir(path.join(tempRoot, 'project'), { recursive: true });
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tempRoot, 'sessions');
    process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, 'agent');
    spawnMock = mock();
    Bun.spawn = spawnMock;
  });

  afterEach(async () => {
    Bun.spawn = originalSpawn;
    process.env = { ...originalEnv };
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it('forwards supported effort, clamps larger modes, and maps none to off', async () => {
    spawnMock
      .mockReturnValueOnce(createCompletedProc())
      .mockReturnValueOnce(createCompletedProc())
      .mockReturnValueOnce(createCompletedProc());

    await runSingleQuery('hello', {
      cwd: path.join(tempRoot, 'project'),
      model: 'github-copilot/gpt-5.4',
      thinkingMode: 'high',
    }, testPiConfig);
    await runSingleQuery('hello', {
      cwd: path.join(tempRoot, 'project'),
      model: 'github-copilot/gpt-5.4',
      thinkingMode: 'ultra',
    }, testPiConfig);
    await runSingleQuery('hello', {
      cwd: path.join(tempRoot, 'project'),
      model: 'github-copilot/gpt-5.4',
      thinkingMode: 'none',
    }, testPiConfig);

    expect(spawnMock.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['--mode', 'text', '--no-session', '--no-tools']),
    );
    expect(spawnMock.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['--thinking', 'high']),
    );
    expect(spawnMock.mock.calls[1][0]).toEqual(
      expect.arrayContaining(['--thinking', 'xhigh']),
    );
    expect(spawnMock.mock.calls[2][0]).toEqual(
      expect.arrayContaining(['--thinking', 'off']),
    );
  });

  it('rejects the default model because Pi requires an explicit selection', async () => {
    await expect(runSingleQuery('hello', {
      cwd: path.join(tempRoot, 'project'),
      model: 'default',
    }, testPiConfig)).rejects.toThrow('Pi requires an explicit model selection.');
    expect(() => requireExplicitPiModel('')).toThrow();
    expect(() => requireExplicitPiModel('default')).toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('surfaces single-query failures with the exit code and stderr details', async () => {
    spawnMock.mockReturnValueOnce(createFailedProc(3, 'no session found'));
    await expect(runSingleQuery('hello', {
      cwd: path.join(tempRoot, 'project'),
      model: 'github-copilot/gpt-5.4',
    }, testPiConfig)).rejects.toThrow('Pi command failed with code 3: no session found');
  });

  it('scrubs nested Pi session environment and preserves extension configuration', async () => {
    process.env.PI_CODING_AGENT = '1';
    process.env.PI_SESSION_FILE = '/home/someone/session.jsonl';
    process.env.PI_SESSION_ID = 'outer-session';
    process.env.PI_PROVIDER = 'outer-provider';
    process.env.PI_MODEL = 'outer-model';
    process.env.PI_REASONING_LEVEL = 'high';
    process.env.PI_CODING_AGENT_SESSION_DIR = '/home/someone/sessions';
    process.env.PI_MODELS_DEV_OVERRIDE_PROVIDERS = 'all';
    process.env.PI_OFFLINE = '0';
    process.env.PI_SKIP_VERSION_CHECK = '0';
    process.env.PI_TELEMETRY = '1';
    process.env.PI_PACKAGE_DIR = path.join(tempRoot, 'garcon-pi-package');
    process.env.GARCON_EMBEDDED_PI_PACKAGE_DIR = process.env.PI_PACKAGE_DIR;

    const env = buildPiCliEnv({
      PI_OFFLINE: '0',
      PI_SKIP_VERSION_CHECK: '0',
      PI_TELEMETRY: '1',
    });

    for (const name of [
      'PI_CODING_AGENT',
      'PI_SESSION_FILE',
      'PI_SESSION_ID',
      'PI_PROVIDER',
      'PI_MODEL',
      'PI_REASONING_LEVEL',
      'PI_CODING_AGENT_SESSION_DIR',
      'PI_PACKAGE_DIR',
      'GARCON_EMBEDDED_PI_PACKAGE_DIR',
    ]) {
      expect(env[name]).toBeUndefined();
    }
    // Offline flags win over both inherited and request-level overrides.
    expect(env.PI_OFFLINE).toBe('1');
    expect(env.PI_SKIP_VERSION_CHECK).toBe('1');
    expect(env.PI_TELEMETRY).toBe('0');
    expect(env.PI_MODELS_DEV_OVERRIDE_PROVIDERS).toBe('all');
  });

  it('prefixes plan-mode prompts and leaves other modes untouched', async () => {
    expect(buildPiPrompt('do it', 'default', false)).toBe('do it');
    expect(buildPiPrompt('do it', 'plan', false)).toBe(`${PI_PLAN_PREFIX}\n\ndo it`);
    expect(buildPiPrompt('', 'default', true)).toBe('Please inspect the attached image.');
  });
});
