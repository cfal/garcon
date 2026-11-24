import os from 'node:os';

export const testPiConfig = {
  binary: () => process.env.GARCON_PI_BINARY ?? process.env.PI_BINARY ?? 'pi',
  agentDirectoryOverride: () => process.env.PI_CODING_AGENT_DIR ?? null,
  sessionDirectoryOverride: () => process.env.PI_CODING_AGENT_SESSION_DIR ?? null,
  homeDirectory: () => process.env.HOME ?? os.homedir(),
  isTestEnvironment: () => true,
};

export const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const testModels = {
  async getModels() {
    return [];
  },
};
