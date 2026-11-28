import assert from 'node:assert/strict';
import { join } from 'node:path';
import jwt from '../../../../server/node_modules/jsonwebtoken/index.js';
import { AuthAccountStore } from '../../../../server/controller/auth/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Authentication fixture expects Bun 1.4.3, got ${Bun.version}`);
const [stage, dir] = Bun.argv.slice(2);
const ownerKey = 'fixture-owner';
const sessionId = 'a'.repeat(64);
const expiresAtMs = 4_102_444_800_125;
const password = 'a'.repeat(72) + 'A';
const store = new AuthAccountStore(join(dir, 'auth.json'));

if (stage === 'prepare') {
  const state = await store.snapshot();
  const passwordHash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 });
  await store.register(state, () => ({
    account: { ownerKey, credentialRevision: 1, username: ownerKey, passwordHash, createdAt: null },
    session: { sessionId, ownerKey, expiresAtMs },
    result: undefined,
  }));
  const sign = (key: string) => jwt.sign({
    sub: ownerKey, credentialRevision: 1, sid: sessionId, exp: expiresAtMs / 1000,
    iat: 1_700_000_000, aud: 'unused',
  }, key, { algorithm: 'HS256' });
  const probes = ['a'.repeat(72), password, '\u00e9'.repeat(37), 'hello\0world'];
  const hashes = await Promise.all(probes.map(async (password) => ({
    password, hash: await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 4 }),
  })));
  hashes.push({
    password: 'argon2 fixture',
    hash: await Bun.password.hash('argon2 fixture', { algorithm: 'argon2id', memoryCost: 8192, timeCost: 1 }),
  });
  await Bun.write(join(dir, 'from-bun.json'), JSON.stringify({
    token: sign(state.jwtSecret), wrongKey: sign('different fixture secret'),
    password, hashes, ownerKey, sessionId, expiresAtMs,
  }));
} else if (stage === 'verify') {
  const state = await store.snapshot();
  assert.ok(state.account);
  assert.equal(state.account.ownerKey, ownerKey);
  assert.equal(state.account.credentialRevision, 2);
  assert.equal(state.account.username, 'fixture-next');
  assert.equal(store.isSessionCurrent(ownerKey, sessionId, expiresAtMs), true);
  const rust = await Bun.file(join(dir, 'from-rust.json')).json();
  assert.equal(await Bun.password.verify(rust.password, state.account.passwordHash), true);
  assert.equal(await Bun.password.verify(rust.password + 'x', state.account.passwordHash), false);
  for (const { password, hash } of rust.hashes) {
    assert.match(hash, /^\$2b\$12\$/);
    assert.equal(await Bun.password.verify(password, hash), true);
  }
  const decoded = jwt.verify(rust.token, state.jwtSecret, { algorithms: ['HS256'] });
  assert.deepEqual(decoded, {
    sub: ownerKey, credentialRevision: 2, sid: sessionId,
    exp: expiresAtMs / 1000, iat: 1_700_000_000,
  });
  const issued = jwt.verify(rust.issuedToken, state.jwtSecret, {
    algorithms: ['HS256'], clockTimestamp: 1_700_000_000,
  });
  assert.notEqual(rust.issued.sessionId, sessionId);
  assert.equal(rust.issued.ownerKey, ownerKey);
  assert.equal(rust.issued.expiresAtMs, (1_700_000_000 + 30 * 86_400) * 1000);
  assert.deepEqual(issued, {
    sub: ownerKey, credentialRevision: 2, sid: rust.issued.sessionId,
    exp: rust.issued.expiresAtMs / 1000, iat: 1_700_000_000,
  });
  // The persisted session is read by the original; its historical fixture
  // expiry is not relative to the wall clock of this verification process.
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    assert.equal(store.isSessionCurrent(ownerKey, rust.issued.sessionId, rust.issued.expiresAtMs), true);
  } finally {
    Date.now = realNow;
  }
} else {
  throw new Error(`Unknown auth crypto fixture stage: ${stage}`);
}
