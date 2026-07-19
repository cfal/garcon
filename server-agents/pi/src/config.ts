import os from 'node:os';
import type { AgentHost } from '@garcon/server-agent-interface';
import { AgentHostEnvironment } from '@garcon/server-agent-common/legacy/host-environment';

const environment = new AgentHostEnvironment();

export function bindAgentHost(host: AgentHost): void { environment.bind(host); }
export function getPiBinary(): string {
  return environment.value('GARCON_PI_BINARY') ?? environment.value('PI_BINARY') ?? 'pi';
}
export function getPiSessionDirOverride(): string | null {
  return environment.value('PI_CODING_AGENT_SESSION_DIR');
}
export function getHomeDir(): string { return environment.value('HOME') ?? os.homedir(); }
export function isTestEnvironment(): boolean { return environment.value('NODE_ENV') === 'test'; }
