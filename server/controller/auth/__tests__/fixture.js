import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthAccountStore } from '../store.js';
import { AuthService } from '../service.js';
import jwt from 'jsonwebtoken';

export const fixturePasswords = {
  verify: async (password, hash) => hash === `hash:${password}`,
  hash: async password => `hash:${password}`,
};

export async function authFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-auth-test-'));
  const filePath = join(directory, 'auth.json');
  const store = new AuthAccountStore(filePath, options.write);
  const passwords = { ...fixturePasswords, ...options.passwords };
  const service = new AuthService(store, passwords);
  let session;
  return { directory, filePath, store, service, passwords,
    register: async () => {
      const response = await service.register({ username: 'owner-before', password: 'password-before' });
      session = jwt.decode(response.token);
      return response;
    },
    principal: async () => {
      const { account } = await store.snapshot();
      session ??= jwt.decode((await service.login({ username: account.username, password: 'password-before' })).token);
      return { mode: 'authenticated', key: account.ownerKey, username: account.username,
        credentialRevision: account.credentialRevision, sessionId: session.sid, expiresAtMs: session.exp * 1000 };
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
