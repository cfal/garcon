import { describe, expect, it } from 'bun:test';
import os from 'os';
import path from 'path';

import {
  getFactoryAuthPaths,
  getFactoryHome,
  getFactorySessionDiscoveryIndexPath,
  getFactorySessionsRoot,
  getFactorySettingsPath,
} from '../factory-paths.js';

describe('factory paths', () => {
  it('uses the default Factory home under the OS home directory', () => {
    const home = path.join(os.homedir(), '.factory');

    expect(getFactoryHome({})).toBe(home);
    expect(getFactorySettingsPath({})).toBe(path.join(home, 'settings.json'));
    expect(getFactorySessionDiscoveryIndexPath({})).toBe(path.join(home, 'cache', 'session-discovery-index.json'));
    expect(getFactorySessionsRoot({})).toBe(path.join(home, 'sessions'));
    expect(getFactoryAuthPaths({})).toEqual([
      path.join(home, 'auth.json'),
      path.join(home, 'auth.v2.file'),
      path.join(home, 'auth.v2.key'),
    ]);
  });

  it('honors FACTORY_HOME_OVERRIDE as Droid home base', () => {
    const env = { FACTORY_HOME_OVERRIDE: '/tmp/factory-home' };

    expect(getFactoryHome(env)).toBe('/tmp/factory-home/.factory');
    expect(getFactorySessionDiscoveryIndexPath(env)).toBe('/tmp/factory-home/.factory/cache/session-discovery-index.json');
    expect(getFactorySessionsRoot(env)).toBe('/tmp/factory-home/.factory/sessions');
  });
});
