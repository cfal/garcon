interface BuildFactoryCliEnvOptions {
  airgap?: boolean;
  baseEnv?: Record<string, string | undefined>;
}

const FACTORY_CLI_ENV_OVERRIDES = {
  FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
  FACTORYD_DISABLE_AUTO_UPDATE: 'true',
  DROID_DISABLE_AUTO_UPDATE: 'true',
} as const;

// Builds the env shared by Droid child processes. Auto-update stays disabled on
// every invocation, while airgap stays opt-in because it hides Factory-hosted
// models during discovery and prevents Factory-hosted runtime access.
export function buildFactoryCliEnv(
  options: BuildFactoryCliEnvOptions = {},
): Record<string, string | undefined> {
  const { airgap = false, baseEnv = process.env } = options;
  const env = {
    ...baseEnv,
    ...FACTORY_CLI_ENV_OVERRIDES,
  };

  if (airgap) {
    env.FACTORY_AIRGAP_ENABLED = '1';
  } else {
    delete env.FACTORY_AIRGAP_ENABLED;
  }

  return env;
}
