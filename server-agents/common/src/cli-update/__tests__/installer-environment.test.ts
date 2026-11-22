import { afterEach, expect, test } from 'bun:test';
import { installerEnvironment } from '../installer-environment.js';

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

test('withholds every provider credential and keeps installer settings', () => {
  Object.assign(process.env, {
    OPENAI_API_KEY: 'synthetic-openai', ANTHROPIC_API_KEY: 'synthetic-anthropic',
    GEMINI_API_KEY: 'synthetic-gemini', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth',
    ANTHROPIC_AUTH_TOKEN: 'synthetic-auth', AWS_BEARER_TOKEN_BEDROCK: 'synthetic-bedrock',
    AWS_SECRET_ACCESS_KEY: 'synthetic-aws', GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/adc.json', CLAUDECODE: '1',
    AMP_API_KEY: 'synthetic-amp', OPENROUTER_API_KEY: 'synthetic-openrouter',
    NPM_TOKEN: 'synthetic-registry', HTTPS_PROXY: 'http://proxy.example.test',
  });
  const environment = installerEnvironment({ CODEX_HOME: '/synthetic/codex' });
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
    'AMP_API_KEY', 'OPENROUTER_API_KEY', 'CLAUDECODE']) {
    expect(environment[key]).toBeUndefined();
  }
  expect(environment.NPM_TOKEN).toBe('synthetic-registry');
  expect(environment.HTTPS_PROXY).toBe('http://proxy.example.test');
  expect(environment.CODEX_HOME).toBe('/synthetic/codex');
});
