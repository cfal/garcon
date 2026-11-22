import { afterEach, expect, test } from 'bun:test';
import { installerEnvironment } from '../installer-environment.js';

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

test('passes the process environment without provider credentials', () => {
  process.env.SYNTHETIC_API_KEY = 'synthetic-secret';
  process.env.SYNTHETIC_REGISTRY = 'https://registry.example.test';
  const environment = installerEnvironment(['SYNTHETIC_API_KEY'], { SYNTHETIC_HOME: '/synthetic/home' });
  expect(environment.SYNTHETIC_API_KEY).toBeUndefined();
  expect(environment.SYNTHETIC_REGISTRY).toBe('https://registry.example.test');
  expect(environment.SYNTHETIC_HOME).toBe('/synthetic/home');
});
