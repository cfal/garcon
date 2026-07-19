import os from 'node:os';
import path from 'node:path';
import type { AgentEnvironmentReader } from '@garcon/server-agent-interface';
import { readEnvironment } from '@garcon/server-agent-common/environment/read-environment';

export interface CodexConfig {
  readonly openAiApiKey: () => string | null;
  readonly openAiBaseUrl: () => string | null;
  readonly home: () => string;
  readonly packageVersion: () => string;
}

export function createCodexConfig(environment: AgentEnvironmentReader): CodexConfig {
  return Object.freeze({
    openAiApiKey: () => readEnvironment(environment, 'OPENAI_API_KEY'),
    openAiBaseUrl: () => readEnvironment(environment, 'OPENAI_BASE_URL'),
    home: () => readEnvironment(environment, 'CODEX_HOME') ?? path.join(os.homedir(), '.codex'),
    packageVersion: () => readEnvironment(environment, 'npm_package_version') ?? '0.1.0',
  });
}
