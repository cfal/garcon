import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FixtureAccount {
  readonly username: string;
  readonly password: string;
}

export async function prepareFixtureAccount(configDirectory: string): Promise<FixtureAccount> {
  const account = { username: 'synthetic-user', password: randomBytes(32).toString('base64url') };
  await writeFile(join(configDirectory, 'auth.json'), JSON.stringify({
    username: account.username,
    passwordHash: await Bun.password.hash(account.password, { algorithm: 'bcrypt', cost: 4 }),
    createdAt: '2026-09-09T00:00:00.000Z',
  }), { mode: 0o600 });
  return account;
}
