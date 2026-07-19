import type { AgentHost } from '@garcon/server-agent-interface';
import { AgentHostEnvironment } from '@garcon/server-agent-common/legacy/host-environment';

const environment = new AgentHostEnvironment();

export function bindAgentHost(host: AgentHost): void { environment.bind(host); }
export function getCursorBinary(): string {
  return environment.value('GARCON_CURSOR_BINARY')
    ?? environment.value('CURSOR_BINARY')
    ?? 'cursor-agent';
}
export function getCursorApiKey(): string | null { return environment.value('CURSOR_API_KEY'); }
