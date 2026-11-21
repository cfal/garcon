import { describe, expect, it } from 'bun:test';
import type { AgentEnvironmentReader } from '@garcon/server-agent-interface';
import { antigravityChildEnvironment, createAntigravityConfig, resolveAuthMethod, type AntigravityConfig } from '../../../config.ts';
import {
  antigravityLoginEnvironment,
  getAntigravityAuthStatus,
  validateAntigravityLoginCode,
} from '../antigravity-auth.ts';
import { antigravityCliFailure, parseAntigravityModels } from '../antigravity-models.ts';

function environment(values: Record<string, string>): AgentEnvironmentReader {
  return { get: (name) => values[name] };
}

function config(overrides: Partial<AntigravityConfig> = {}): AntigravityConfig {
  return {
    binary: () => 'agy',
    apiKey: () => null,
    hasApiKey: () => false,
    authMethod: () => 'oauth-personal',
    ...overrides,
  };
}

describe('Antigravity configuration', () => {
  it('prefers an explicit auth method, then an API key, then Google sign-in', () => {
    expect(resolveAuthMethod('oauth-business', true)).toBe('oauth-business');
    expect(resolveAuthMethod(null, true)).toBe('gemini-api-key');
    expect(resolveAuthMethod(null, false)).toBe('oauth-personal');
    expect(() => resolveAuthMethod('password', false)).toThrow('GARCON_ANTIGRAVITY_AUTH_METHOD must be one of');
  });

  it('reads the binary and credentials only when asked', () => {
    const configured = createAntigravityConfig(environment({
      GARCON_ANTIGRAVITY_BINARY: '/opt/agy/bin/agy',
      GEMINI_API_KEY: 'synthetic-key',
    }));
    expect(configured.binary()).toBe('/opt/agy/bin/agy');
    expect(configured.authMethod()).toBe('gemini-api-key');
    expect(createAntigravityConfig(environment({})).binary()).toBe('agy');
  });
});

describe('parseAntigravityModels', () => {
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

  it('summarizes a signed-out failure without the progress line', () => {
    expect(antigravityCliFailure({
      stdout: '',
      stderr: 'Fetching available models...\nError: Please sign in to view available models.\n',
      exitCode: 1,
    })).toBe('Please sign in to view available models.');
  });
});

describe('getAntigravityAuthStatus', () => {
  it('reports an API key as environment authentication without spawning the CLI', async () => {
    const status = await getAntigravityAuthStatus(config({ hasApiKey: () => true, authMethod: () => 'gemini-api-key' }), { runModels: () => { throw new Error('must not run'); } });
    expect(status).toEqual({ authenticated: true, canReauth: false, label: 'GEMINI_API_KEY', source: 'environment' });
  });

  it('reports an invalid auth-method setting instead of throwing', async () => {
    const status = await getAntigravityAuthStatus(config({
      authMethod: () => resolveAuthMethod('password', false),
    }), { runModels: () => { throw new Error('must not run'); } });
    expect(status).toMatchObject({ authenticated: false, source: 'none' });
    expect(status.detail).toContain('GARCON_ANTIGRAVITY_AUTH_METHOD must be one of');
  });

  it('reports the configured API-key method as signed out without a key', async () => {
    const status = await getAntigravityAuthStatus(config({ authMethod: () => 'gemini-api-key' }), { runModels: () => { throw new Error('must not run'); } });
    expect(status).toEqual({
      authenticated: false, canReauth: false, label: '', source: 'none', detail: 'GEMINI_API_KEY is not set.',
    });
  });

  it('stops waiting on the shared probe when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = getAntigravityAuthStatus(config(), { runModels: () => new Promise(() => {}), signal: controller.signal });
    controller.abort(new Error('caller left'));
    await expect(pending).rejects.toThrow('caller left');
  });

  it('keeps the last probed status during a sign-in and ignores it for the API-key method', async () => {
    const signedIn = { authenticated: true, canReauth: true, label: 'Google', source: 'cli' as const };
    expect(await getAntigravityAuthStatus(config(), {
      runModels: () => { throw new Error('must not run'); }, signInRunning: true, lastProbed: signedIn,
    })).toEqual(signedIn);
    expect(await getAntigravityAuthStatus(config({ hasApiKey: () => true, authMethod: () => 'gemini-api-key' }), {
      runModels: () => { throw new Error('must not run'); }, signInRunning: true,
    })).toMatchObject({ authenticated: true, source: 'environment' });
  });

  it('does not probe the CLI while an in-app sign-in is running', async () => {
    const status = await getAntigravityAuthStatus(config(), {
      runModels: () => { throw new Error('must not run'); },
      signInRunning: true,
    });
    expect(status).toMatchObject({ authenticated: false, detail: 'Sign-in in progress.' });
  });

  it('offers in-app sign-in only for the personal Google method', async () => {
    const ok = async () => ({ stdout: 'm\tM\n', stderr: '', exitCode: 0 });
    const mustNotRun = () => { throw new Error('must not run'); };
    expect(await getAntigravityAuthStatus(config({ authMethod: () => 'agent-platform' }), {
      runModels: mustNotRun, authenticate: async () => {},
    })).toEqual({ authenticated: true, canReauth: false, label: 'agent-platform', source: 'cli' });
    expect(await getAntigravityAuthStatus(config(), { runModels: ok, authenticate: mustNotRun }))
      .toEqual({ authenticated: true, canReauth: true, label: 'Google', source: 'cli' });
  });

  // `agy models` succeeds on any credential the CLI holds, such as a personal
  // login left over from before the method changed.
  it('checks an enterprise method by authenticating with it, not by listing models', async () => {
    const status = await getAntigravityAuthStatus(config({ authMethod: () => 'agent-platform' }), {
      runModels: async () => ({ stdout: 'm\tM\n', stderr: '', exitCode: 0 }),
      authenticate: async () => { throw new Error('GOOGLE_CLOUD_PROJECT must be set for Agent Platform authentication.'); },
    });
    expect(status).toMatchObject({
      authenticated: false,
      canReauth: false,
      detail: 'GOOGLE_CLOUD_PROJECT must be set for Agent Platform authentication.',
    });
  });

  it('stops waiting on a shared enterprise probe when the status check is aborted', async () => {
    const controller = new AbortController();
    const pending = getAntigravityAuthStatus(config({ authMethod: () => 'oauth-business' }), {
      signal: controller.signal,
      authenticate: () => new Promise(() => {}),
    });
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
  });

  it('uses the CLI model listing as the signed-in check', async () => {
    const signedIn = await getAntigravityAuthStatus(config(), { runModels: async () => ({ stdout: 'm\tM\n', stderr: '', exitCode: 0 }) });
    expect(signedIn).toMatchObject({ authenticated: true, source: 'cli' });

    const signedOut = await getAntigravityAuthStatus(config(), { runModels: async () => ({
      stdout: '',
      stderr: 'Error: Please sign in to view available models.',
      exitCode: 1,
    }) });
    expect(signedOut).toEqual({
      authenticated: false,
      canReauth: true,
      label: '',
      source: 'none',
      detail: 'Please sign in to view available models.',
    });
  });
});

describe('Antigravity login', () => {
  it('removes display variables so the CLI prints its sign-in link', () => {
    const previous = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
    process.env.DISPLAY = ':0';
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    try {
      const env = antigravityLoginEnvironment({ apiKey: () => 'synthetic-key', authMethod: () => 'gemini-api-key' });
      expect(env.DISPLAY).toBeUndefined();
      expect(env.WAYLAND_DISPLAY).toBeUndefined();
      expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('1');
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
