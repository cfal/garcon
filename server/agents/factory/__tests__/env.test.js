import { describe, expect, it } from 'bun:test';

import { buildFactoryCliEnv } from '../factory-env.js';

describe('buildFactoryCliEnv', () => {
  it('disables Droid auto-update without enabling airgap by default', () => {
    expect(buildFactoryCliEnv({
      baseEnv: {
        KEEP_ME: 'yes',
        FACTORY_AIRGAP_ENABLED: '1',
        FACTORY_DROID_AUTO_UPDATE_ENABLED: 'true',
        FACTORYD_DISABLE_AUTO_UPDATE: 'false',
        DROID_DISABLE_AUTO_UPDATE: 'false',
      },
    })).toEqual({
      KEEP_ME: 'yes',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      FACTORYD_DISABLE_AUTO_UPDATE: 'true',
      DROID_DISABLE_AUTO_UPDATE: 'true',
    });
  });

  it('enables airgap only when requested for custom model execution', () => {
    expect(buildFactoryCliEnv({
      airgap: true,
      baseEnv: {
        KEEP_ME: 'yes',
        FACTORY_AIRGAP_ENABLED: '0',
      },
    })).toMatchObject({
      KEEP_ME: 'yes',
      FACTORY_AIRGAP_ENABLED: '1',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      FACTORYD_DISABLE_AUTO_UPDATE: 'true',
      DROID_DISABLE_AUTO_UPDATE: 'true',
    });
  });
});
