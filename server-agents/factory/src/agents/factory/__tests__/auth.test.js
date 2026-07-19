import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { getFactoryAuthStatus } from '../factory-auth.js';

const config = {
  binary: () => 'droid',
  apiKey: () => process.env.FACTORY_API_KEY?.trim() || null,
  homeOverride: () => process.env.FACTORY_HOME_OVERRIDE?.trim() || null,
};

describe('getFactoryAuthStatus', () => {
  const originalApiKey = process.env.FACTORY_API_KEY;
  const originalFactoryHomeOverride = process.env.FACTORY_HOME_OVERRIDE;
  let tmpDir = null;

  afterEach(async () => {
    if (originalApiKey === undefined) {
      delete process.env.FACTORY_API_KEY;
    } else {
      process.env.FACTORY_API_KEY = originalApiKey;
    }
    if (originalFactoryHomeOverride === undefined) {
      delete process.env.FACTORY_HOME_OVERRIDE;
    } else {
      process.env.FACTORY_HOME_OVERRIDE = originalFactoryHomeOverride;
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { force: true, recursive: true });
      tmpDir = null;
    }
  });

  it('treats FACTORY_API_KEY as authenticated', async () => {
    process.env.FACTORY_API_KEY = 'fk-test-key';
    const status = await getFactoryAuthStatus(config);

    expect(status).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
  });

  it('checks auth artifacts under FACTORY_HOME_OVERRIDE', async () => {
    delete process.env.FACTORY_API_KEY;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-factory-auth-tests-'));
    process.env.FACTORY_HOME_OVERRIDE = tmpDir;
    const authPath = path.join(tmpDir, '.factory', 'auth.v2.key');
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(authPath, 'token', 'utf8');

    const status = await getFactoryAuthStatus(config);

    expect(status).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
  });
});
