import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../common/json.js';

export async function prepareFixtureAuth(configDir: string): Promise<{ username: string; password: string }> {
  await mkdir(configDir, { recursive: true });
  const authPath = join(configDir, 'auth.json');
  const stored: unknown = await readFile(authPath, 'utf8').then(
    contents => JSON.parse(contents),
    error => { if (error.code === 'ENOENT') return {}; throw error; },
  );
  if (!isRecord(stored)) throw new Error('Invalid fixture authentication state');
  const credentials = { username: 'integration', password: randomBytes(32).toString('hex') };
  await writeFile(authPath, JSON.stringify({
    username: credentials.username,
    passwordHash: await Bun.password.hash(credentials.password, { algorithm: 'bcrypt', cost: 4 }),
    // Existing browser tokens remain valid through a controller restart.
    jwtSecret: typeof stored.jwtSecret === 'string' && stored.jwtSecret
      ? stored.jwtSecret : randomBytes(32).toString('hex'),
  }), { mode: 0o600 });
  return credentials;
}

export async function fixtureAuthToken(baseUrl: string, credentials: { username: string; password: string }): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json();
  if (!response.ok || !isRecord(body) || typeof body.token !== 'string' || !body.token) {
    throw new Error(`Fixture authentication failed (${response.status})`);
  }
  return body.token;
}
