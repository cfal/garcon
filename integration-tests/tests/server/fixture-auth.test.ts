import { expect, test } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareFixtureAuth } from '../../support/fixture-auth.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test.each(['in-process', 'remote-controller-dials', 'remote-node-dials'] as const)(
  'controller fixtures require authentication and retain it across restart (%s)',
  async (executionBackend) => {
    await withIntegrationFixture(`fixture-auth-${executionBackend}`, async (fixture) => {
      const baseUrl = fixture.garcon.baseUrl;
      const token = fixture.garcon.authToken;
      expect(token).toBeString();
      expect((await fetch(`${baseUrl}/api/v1/chats`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/ws`, {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'c3ludGhldGljLXNvY2tldA==', 'Sec-WebSocket-Version': '13' },
      })).status).toBe(401);
      expect(await (await fetch(`${baseUrl}/api/v1/auth/status`)).json()).toMatchObject({
        authDisabled: false, needsSetup: false,
      });
      expect((await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'uninvited', password: 'synthetic-password' }),
      })).status).toBe(409);
      await fixture.client.ping();
      const observer = await fixture.connectObserver('authenticated');
      await observer.ping();
      expect(() => fixture.client.fetch('https://example.invalid/')).toThrow('controller origin');

      const separateConfig = join(fixture.dirs.root, 'separate-auth');
      await mkdir(separateConfig);
      await prepareFixtureAuth(separateConfig);
      const originalAuth = JSON.parse(await readFile(join(fixture.dirs.config, 'auth.json'), 'utf8'));
      const separateAuth = JSON.parse(await readFile(join(separateConfig, 'auth.json'), 'utf8'));
      expect(separateAuth.jwtSecret).not.toBe(originalAuth.jwtSecret);
      expect(separateAuth.passwordHash).not.toBe(originalAuth.passwordHash);

      await fixture.restartGarcon();
      const response = await fetch(`${fixture.garcon.baseUrl}/api/v1/chats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      await fixture.client.ping();
    }, { executionBackend });
  },
  40_000,
);
