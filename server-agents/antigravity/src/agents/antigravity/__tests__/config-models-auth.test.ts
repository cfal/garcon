import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdtempDisposable, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, relative } from 'node:path';
import type { AgentEnvironmentReader, AgentLogger } from '@garcon/server-agent-interface';
import { antigravityChildEnvironment, classifyAntigravityLaunchError, createAntigravityConfig, resolveAuthMethod, type AntigravityConfig } from '../../../config.ts';
import {
  antigravityLoginCommand,
  antigravityLoginEnvironment,
  createAntigravityProbes,
  getAntigravityAuthStatus,
  validateAntigravityLoginCode,
} from '../antigravity-auth.ts';
import { antigravityCliFailure, createAntigravityCatalog, parseAntigravityModels, runAntigravityModels } from '../antigravity-models.ts';
import { createAntigravityAccount } from '../antigravity-account.ts';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } satisfies AgentLogger;

function environment(values: Record<string, string>): AgentEnvironmentReader {
  return { get: (name) => values[name] };
}

function config(overrides: Partial<AntigravityConfig> = {}): AntigravityConfig {
  return {
    binary: () => process.execPath,
    apiKey: () => null,
    authMethod: () => 'oauth-personal',
    ...overrides,
  };
}

describe('Antigravity configuration', () => {
  it.each(['EACCES', 'ENOEXEC', 'ELIBBAD', 'EBADARCH'])('reports a permanent executable failure for %s', code => {
    const cause = Object.assign(new Error('Cannot execute binary'), { syscall: 'posix_spawn', code });
    expect(classifyAntigravityLaunchError(cause)).toMatchObject({ code: 'BINARY_NOT_FOUND', retryable: false });
  });

  it.each(['EAGAIN', 'EMFILE', 'ENOMEM', 'ETXTBSY'])('preserves a temporary spawn error for %s', code => {
    const cause = Object.assign(new Error('Cannot start process yet'), { syscall: 'posix_spawn', code });
    expect(classifyAntigravityLaunchError(cause)).toBe(cause);
  });

  it('prefers an explicit auth method, then an API key, then Google sign-in', () => {
    expect(resolveAuthMethod('oauth-business', true)).toBe('oauth-business');
    expect(resolveAuthMethod(null, true)).toBe('gemini-api-key');
    expect(resolveAuthMethod(null, false)).toBe('oauth-personal');
    expect(() => resolveAuthMethod('password', false)).toThrow('GARCON_ANTIGRAVITY_AUTH_METHOD must be one of');
  });

  it('resolves relative overrides and the current PATH against the executor, not the chat project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-bin-'));
    const path = process.env.PATH;
    try {
      const binary = join(root, 'agy');
      const configured = createAntigravityConfig(environment({
        GARCON_ANTIGRAVITY_BINARY: relative(process.cwd(), binary), GEMINI_API_KEY: 'synthetic-key',
      }));
      expect(() => configured.binary()).toThrow('Install agy');
      await symlink(process.execPath, binary);
      expect(isAbsolute(configured.binary())).toBe(true);
      expect(normalize(configured.binary())).toBe(binary);
      expect(configured.authMethod()).toBe('gemini-api-key');
      process.env.PATH = root;
      expect(createAntigravityConfig(environment({})).binary()).toBe(binary);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('parseAntigravityModels', () => {
  it('does not offer Default when agy exists but the OS cannot launch it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-launch-'));
    try {
      const binary = join(root, 'agy');
      await writeFile(binary, `#!${join(root, 'missing-interpreter')}\n`, { mode: 0o700 });
      const config = createAntigravityConfig(environment({ GARCON_ANTIGRAVITY_BINARY: binary }));
      expect(config.binary()).toBe(binary);
      const catalog = createAntigravityCatalog(createAntigravityProbes(config).runModels, silentLogger);
      const signal = new AbortController().signal;
      expect((await catalog.snapshot({ signal, strict: false })).models).toEqual([]);
      await expect(catalog.snapshot({ signal, strict: true })).rejects.toMatchObject({ code: 'BINARY_NOT_FOUND' });
      for (const authMethod of ['oauth-personal', 'gemini-api-key'] as const) {
        const account = createAntigravityAccount({ ...config, authMethod: () => authMethod, apiKey: () => 'test-key' }, silentLogger);
        try {
          expect(await account.auth.status(signal)).toMatchObject({ authenticated: false, canReauth: false });
          if (authMethod === 'oauth-personal') await expect(account.auth.launchLogin()).rejects.toMatchObject({ code: 'BINARY_NOT_FOUND' });
        } finally { account.stop(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('lists no models for an invalid auth method and reports its cause on strict discovery', async () => {
    const config = createAntigravityConfig(environment({
      GARCON_ANTIGRAVITY_BINARY: process.execPath, GARCON_ANTIGRAVITY_AUTH_METHOD: 'invalid-method',
    }));
    const catalog = createAntigravityCatalog(createAntigravityProbes(config).runModels, silentLogger);
    const signal = new AbortController().signal;
    expect((await catalog.snapshot({ signal, strict: false })).models).toEqual([]);
    await expect(catalog.snapshot({ signal, strict: true })).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
  });

  it.each(['', 'model-a\tModel A\ndefault\tOther'])('puts native Default first independently of discovered IDs: %j', async (stdout) => {
    const catalog = createAntigravityCatalog(async () => ({ stdout, stderr: '', exitCode: 0 }), silentLogger);
    const snapshot = await catalog.snapshot({ signal: new AbortController().signal, strict: false });
    expect(snapshot.defaultModel).toBe('default');
    expect(snapshot.models).toEqual([{ value: 'default', label: 'Default', supportsImages: true },
      ...(stdout ? [{ value: 'model-a', label: 'Model A', supportsImages: true }] : [])]);
  });

  it('reads tab-separated ids and labels and ignores status lines', () => {
    expect(parseAntigravityModels([
      'Fetching available models...',
      'gemini-test-pro-high\tGemini Test Pro (High)',
      'gemini-test-pro-low\tGemini Test Pro (Low)',
      'gemini-test-pro-low\tDuplicate',
      '',
    ].join('\n'))).toEqual([
      { value: 'gemini-test-pro-high', label: 'Gemini Test Pro (High)', supportsImages: true },
      { value: 'gemini-test-pro-low', label: 'Gemini Test Pro (Low)', supportsImages: true },
    ]);
  });

  it('keeps Default usable for delegated start selection without confirming failed native discovery', async () => {
    const catalog = createAntigravityCatalog(async () => ({ exitCode: 7, stdout: '', stderr: 'Using current profile' }), silentLogger);
    const signal = new AbortController().signal;
    expect((await catalog.snapshot({ strict: false, signal })).models.map(model => model.value)).toEqual(['default']);
    expect((await catalog.snapshot({ strict: true, signal })).models.map(model => model.value)).toEqual(['default']);
    await expect(catalog.snapshot({ strict: true, requireNativeDiscovery: true, signal })).rejects.toMatchObject({
      code: 'UNAVAILABLE', message: 'agy models exited with code 7: Using current profile',
    });
  });

  it('summarizes a signed-out failure without the progress line', () => {
    expect(antigravityCliFailure({
      stdout: '',
      stderr: 'Fetching available models...\nError: Please sign in to view available models.\n',
      exitCode: 1,
    })).toBe('agy models exited with code 1: Please sign in to view available models.');
  });

  it('accepts a successful listing with a diagnostic on stderr', async () => {
    const catalog = createAntigravityCatalog(async () => ({ exitCode: 0, stdout: 'm\tModel\n', stderr: 'Using current profile' }), silentLogger);
    const snapshot = await catalog.snapshot({ strict: true, requireNativeDiscovery: true, signal: new AbortController().signal });
    expect(snapshot.models.map(model => model.value)).toEqual(['default', 'm']);
  });

  it('reports a listing timeout rather than the subprocess banner or termination code', async () => {
    await using dir = await mkdtempDisposable(join(tmpdir(), 'agy-models-timeout-'));
    const binary = join(dir.path, 'agy');
    await writeFile(binary, '#!/bin/sh\necho "Using current profile" >&2\nexec sleep 15\n', { mode: 0o700 });
    await expect(runAntigravityModels(config({ binary: () => binary }), 100)).rejects.toThrow('agy models timed out after 100 ms');
  });
});

describe('getAntigravityAuthStatus', () => {
  const noProbes = {
    runModels: () => { throw new Error('Unexpected model listing'); },
    authenticate: () => { throw new Error('Unexpected authentication probe'); },
  };

  it('does not report a successful sign-in when the ACP peer offers no in-band authentication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-external-auth-'));
    try {
      const binary = join(root, 'agy');
      await writeFile(binary, `#!/bin/sh
read -r init && echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"authMethods":[]}}'
read -r next && case "$next" in *'"method":"authenticate"'*) echo '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Unexpected authenticate"}}';; esac
`, { mode: 0o700 });
      const external = config({ binary: () => binary });
      const status = await getAntigravityAuthStatus(external, { ...createAntigravityProbes(external), headlessAuthenticate: true });
      expect(status).toMatchObject({ authenticated: false, source: 'unknown', canReauth: false });
      expect(status.detail).toContain('does not advertise in-band authentication');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['oauth-personal', 'gemini-api-key'])('does not offer sign-in or report ready for %s when agy is missing', async (method) => {
    const status = await getAntigravityAuthStatus(createAntigravityConfig(environment({
      GARCON_ANTIGRAVITY_BINARY: '/synthetic/uninstalled/agy', GARCON_ANTIGRAVITY_AUTH_METHOD: method, GEMINI_API_KEY: 'synthetic-key',
    })), noProbes);
    expect(status).toMatchObject({ authenticated: false, canReauth: false, detail: expect.stringContaining('Install agy') });
  });

  it('reports an API key as environment authentication without making a credential or model request', async () => {
    const status = await getAntigravityAuthStatus(config({ apiKey: () => 'synthetic-key', authMethod: () => 'gemini-api-key' }), noProbes);
    expect(status).toEqual({ authenticated: true, canReauth: false, label: 'GEMINI_API_KEY', source: 'environment' });
  });

  it('reports an invalid auth-method setting instead of throwing', async () => {
    const status = await getAntigravityAuthStatus(config({
      authMethod: () => resolveAuthMethod('password', false),
    }), noProbes);
    expect(status).toMatchObject({ authenticated: false, source: 'none' });
    expect(status.detail).toContain('GARCON_ANTIGRAVITY_AUTH_METHOD must be one of');
  });

  it('reports the configured API-key method as signed out without a key', async () => {
    const status = await getAntigravityAuthStatus(config({ authMethod: () => 'gemini-api-key' }), noProbes);
    expect(status).toEqual({
      authenticated: false, canReauth: false, label: '', source: 'none', detail: 'GEMINI_API_KEY is not set.',
    });
  });

  it('stops waiting on the shared probe when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = getAntigravityAuthStatus(config(), { ...noProbes, headlessAuthenticate: false, runModels: () => new Promise(() => {}), signal: controller.signal });
    controller.abort(new Error('caller left'));
    await expect(pending).rejects.toThrow('caller left');
  });

  it('keeps the last probed status during a sign-in and ignores it for the API-key method', async () => {
    const signedIn = { authenticated: true, canReauth: true, label: 'Google', source: 'cli' as const };
    expect(await getAntigravityAuthStatus(config(), {
      ...noProbes, signInRunning: true, lastProbed: signedIn,
    })).toEqual(signedIn);
    expect(await getAntigravityAuthStatus(config({ apiKey: () => 'synthetic-key', authMethod: () => 'gemini-api-key' }), {
      ...noProbes, signInRunning: true,
    })).toMatchObject({ authenticated: true, source: 'environment' });
  });

  it('does not probe the CLI while an in-app sign-in is running', async () => {
    const status = await getAntigravityAuthStatus(config(), {
      ...noProbes, signInRunning: true,
    });
    expect(status).toMatchObject({ authenticated: false, detail: 'Sign-in in progress.' });
  });

  it('offers in-app sign-in only for the personal Google method', async () => {
    expect(await getAntigravityAuthStatus(config({ authMethod: () => 'agent-platform' }), {
      ...noProbes, authenticate: async () => true, headlessAuthenticate: true,
    })).toEqual({ authenticated: true, canReauth: false, label: 'agent-platform', source: 'cli' });
    expect(await getAntigravityAuthStatus(config(), { ...noProbes, authenticate: async () => true, headlessAuthenticate: true }))
      .toEqual({ authenticated: true, canReauth: true, label: 'Google', source: 'cli' });
  });

  // `agy models` succeeds on any credential the CLI holds, such as a personal
  // login left over from before the method changed.
  it('checks an enterprise method by authenticating with it, not by listing models', async () => {
    const status = await getAntigravityAuthStatus(config({ authMethod: () => 'agent-platform' }), {
      runModels: async () => ({ stdout: 'm\tM\n', stderr: '', exitCode: 0 }),
      authenticate: async () => { throw new Error('GOOGLE_CLOUD_PROJECT must be set for Agent Platform authentication.'); },
      headlessAuthenticate: true,
    });
    expect(status).toMatchObject({
      authenticated: false,
      canReauth: false,
      detail: 'GOOGLE_CLOUD_PROJECT must be set for Agent Platform authentication.',
    });
  });

  it('checks an enterprise method with agy models where authenticate could open a browser', async () => {
    const status = await getAntigravityAuthStatus(config({ authMethod: () => 'oauth-business' }), {
      ...noProbes,
      headlessAuthenticate: false,
      runModels: async () => ({ stdout: 'm\tM\n', stderr: '', exitCode: 0 }),
    });
    expect(status).toEqual({ authenticated: true, canReauth: false, label: 'oauth-business', source: 'cli' });
  });

  it('stops waiting on a shared enterprise probe when the status check is aborted', async () => {
    const controller = new AbortController();
    const pending = getAntigravityAuthStatus(config({ authMethod: () => 'oauth-business' }), {
      ...noProbes,
      signal: controller.signal,
      authenticate: () => new Promise(() => {}),
      headlessAuthenticate: true,
    });
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
  });

  it('does not accept a model listing as proof of personal sign-in on a headless executor', async () => {
    const status = await getAntigravityAuthStatus(config(), {
      headlessAuthenticate: true,
      runModels: async () => ({ stdout: 'm\tM\n', stderr: '', exitCode: 0 }),
      authenticate: async () => { throw new Error('Personal sign-in required'); },
    });
    expect(status).toMatchObject({ authenticated: false, canReauth: true, detail: 'Personal sign-in required' });
  });

  it('uses the CLI model listing where personal authenticate could open a browser', async () => {
    const signedIn = await getAntigravityAuthStatus(config(), { ...noProbes, headlessAuthenticate: false, runModels: async () => ({ stdout: 'm\tM\n', stderr: '', exitCode: 0 }) });
    expect(signedIn).toMatchObject({ authenticated: true, source: 'cli' });

    const signedOut = await getAntigravityAuthStatus(config(), { ...noProbes, headlessAuthenticate: false, runModels: async () => ({
      stdout: '',
      stderr: 'Error: Please sign in to view available models.',
      exitCode: 1,
    }) });
    expect(signedOut).toEqual({
      authenticated: false,
      canReauth: true,
      label: '',
      source: 'none',
      detail: 'agy models exited with code 1: Please sign in to view available models.',
    });
  });
});

describe('Antigravity login', () => {
  it('does not launch personal sign-in for API-key or enterprise authentication', () => {
    expect(antigravityLoginCommand(config())).toEqual([process.execPath, 'acp', '--login']);
    for (const method of ['gemini-api-key', 'oauth-business', 'agent-platform'] as const) {
      expect(() => antigravityLoginCommand(config({ authMethod: () => method }))).toThrow('requires oauth-personal');
    }
  });

  it('removes display variables so the CLI prints its sign-in link', () => {
    const previous = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
    process.env.DISPLAY = ':0';
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    try {
      const env = antigravityLoginEnvironment({ apiKey: () => 'synthetic-key', authMethod: () => 'gemini-api-key' });
      expect(env.DISPLAY).toBeUndefined();
      expect(env.WAYLAND_DISPLAY).toBeUndefined();
      expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
      expect(env.GEMINI_API_KEY).toBe('synthetic-key');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('gives agy a Gemini key only under the API-key method', () => {
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'ambient-key';
    try {
      expect(antigravityChildEnvironment({ apiKey: () => 'configured-key', authMethod: () => 'gemini-api-key' }).GEMINI_API_KEY).toBe('configured-key');
      expect(antigravityChildEnvironment({ apiKey: () => 'configured-key', authMethod: () => 'oauth-personal' }).GEMINI_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous;
    }
  });

  it('accepts a bare code or the final callback URL', () => {
    expect(validateAntigravityLoginCode('4/synthetic-code')).toBeNull();
    expect(validateAntigravityLoginCode('https://antigravity.google/oauth-callback?code=synthetic')).toBeNull();
    expect(validateAntigravityLoginCode('two words')).not.toBeNull();
  });
});
